/**
 * @file Regression: Claude Code stamps subagent hook events with the acting
 * subagent's own id (`agent_id`) and type. That id is authoritative and must
 * win over the "who looks busy right now" heuristics in routes/hooks.js.
 *
 * Two defects motivated this, both measured against a live 670MB dashboard DB
 * on 2026-08-12:
 *
 *   1. ATTRIBUTION — hooks.js started from the main agent and only reassigned
 *      via findDeepestWorkingAgent (which requires main to be 'waiting'), so a
 *      subagent's tool calls were filed under the main agent. 98% of the tool
 *      events whose payload named a subagent were stored as `<session>-main`.
 *
 *   2. DUPLICATION — scripts/import-history.js later re-imported those same
 *      tool calls from the subagent transcript under `<session>-jsonl-<id>`.
 *      Its idempotency probe keys on (agent_id, event_type, tool_use_id), and
 *      since the agent_id it looks under is the one it invented, it could never
 *      see the hook's copy. Result: every subagent tool call stored twice —
 *      21 155 duplicate rows, 15.6% of all tool events.
 *
 * Both are fixed by resolving the payload id to a real agent row (adopting the
 * live spawn row when there is one) and recording it as agents.claude_agent_id,
 * which import-history.js then matches exactly.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const TEST_DB = path.join(os.tmpdir(), `claude-agent-id-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;
process.env.DASHBOARD_LIVENESS_PROBE = "0";

const { createApp, startServer } = require("../index");
const dbModule = require("../db");
const { db, stmts } = dbModule;
const importHistory = require("../../scripts/import-history");

let server;
let BASE;

function fetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const hook = (hook_type, data) =>
  fetch("/api/hooks/event", { method: "POST", body: { hook_type, data } });

/** Session with main working and one live subagent row from an "Agent" spawn. */
async function sessionWithLiveSubagent(sid, subagentType) {
  await hook("SessionStart", { session_id: sid });
  await hook("UserPromptSubmit", { session_id: sid, prompt: "go" });
  await hook("PreToolUse", {
    session_id: sid,
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, prompt: "investigate" },
  });
}

const subagentsOf = (sid) =>
  db.prepare("SELECT * FROM agents WHERE session_id = ? AND type = 'subagent'").all(sid);

const eventsOf = (sid, eventType) =>
  db
    .prepare("SELECT * FROM events WHERE session_id = ? AND event_type = ? ORDER BY id")
    .all(sid, eventType);

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TEST_DB + suffix);
    } catch {
      /* ignore */
    }
  }
});

describe("hook payload agent_id — attribution", () => {
  it("files a subagent's tool events under the subagent, not the main agent", async () => {
    const sid = "cai-attribution";
    await sessionWithLiveSubagent(sid, "general-purpose");

    await hook("PreToolUse", {
      session_id: sid,
      tool_name: "Bash",
      tool_use_id: "toolu_cai_1",
      agent_id: "hashaaa111",
      agent_type: "general-purpose",
    });

    const pre = eventsOf(sid, "PreToolUse");
    const bash = pre.find((e) => e.tool_name === "Bash");
    assert.ok(bash, "the Bash PreToolUse event should be stored");
    assert.notEqual(bash.agent_id, `${sid}-main`, "must not be filed under the main agent");

    const owner = stmts.getAgent.get(bash.agent_id);
    assert.equal(owner.type, "subagent");
    assert.equal(owner.claude_agent_id, "hashaaa111", "payload id should be recorded on the row");
  });

  it("adopts the live spawn row instead of creating a second subagent", async () => {
    const sid = "cai-adopt";
    await sessionWithLiveSubagent(sid, "general-purpose");
    const spawned = subagentsOf(sid);
    assert.equal(spawned.length, 1, "precondition: exactly one live subagent from the spawn");

    // Two events from the same subagent must both land on that one row.
    for (const id of ["toolu_cai_2", "toolu_cai_3"]) {
      await hook("PreToolUse", {
        session_id: sid,
        tool_name: "Read",
        tool_use_id: id,
        agent_id: "hashbbb222",
        agent_type: "general-purpose",
      });
    }

    const after = subagentsOf(sid);
    assert.equal(after.length, 1, "no parallel row may be created for the same subagent");
    assert.equal(after[0].id, spawned[0].id, "the live spawn row is the one adopted");
    assert.equal(after[0].claude_agent_id, "hashbbb222");
  });

  it("creates a JSONL-keyed row when there is no live row to adopt", async () => {
    const sid = "cai-orphan";
    await hook("SessionStart", { session_id: sid });
    await hook("UserPromptSubmit", { session_id: sid, prompt: "go" });

    await hook("PostToolUse", {
      session_id: sid,
      tool_name: "Grep",
      tool_use_id: "toolu_cai_4",
      agent_id: "hashccc333",
      agent_type: "Explore",
    });

    const subs = subagentsOf(sid);
    assert.equal(subs.length, 1);
    assert.equal(
      subs[0].id,
      `${sid}-jsonl-hashccc333`,
      "must use the id scheme import-history.js derives from the transcript"
    );
    assert.equal(subs[0].subagent_type, "Explore");
  });

  it("completes the named subagent on SubagentStop, not merely the oldest working one", async () => {
    const sid = "cai-stop";
    await sessionWithLiveSubagent(sid, "reviewer");
    // A second, older working subagent the old fallback would have picked.
    await hook("PreToolUse", {
      session_id: sid,
      tool_name: "Read",
      tool_use_id: "toolu_cai_5",
      agent_id: "hashddd444",
      agent_type: "planner",
    });

    await hook("SubagentStop", { session_id: sid, agent_id: "hashddd444" });

    const stopped = db
      .prepare("SELECT * FROM agents WHERE session_id = ? AND claude_agent_id = ?")
      .get(sid, "hashddd444");
    assert.equal(
      stopped.status,
      "completed",
      "the subagent named by the payload must be the one closed"
    );
  });

  it("leaves main-agent events on the main agent (payload carries no agent_id)", async () => {
    const sid = "cai-main";
    await hook("SessionStart", { session_id: sid });
    await hook("UserPromptSubmit", { session_id: sid, prompt: "go" });
    await hook("PreToolUse", { session_id: sid, tool_name: "Bash", tool_use_id: "toolu_cai_6" });

    const pre = eventsOf(sid, "PreToolUse");
    assert.equal(pre.at(-1).agent_id, `${sid}-main`);
    assert.equal(subagentsOf(sid).length, 0, "no subagent row may be invented");
  });
});

describe("hook payload agent_id — the JSONL import stops duplicating hook events", () => {
  it("does not re-insert a tool call the hooks already recorded", async () => {
    const sid = "cai-nodupe";
    const claudeId = "hasheee555";
    await sessionWithLiveSubagent(sid, "coder");

    // The subagent reports its own tool call through the hooks.
    await hook("PreToolUse", {
      session_id: sid,
      tool_name: "Read",
      tool_use_id: "toolu_shared_1",
      agent_id: claudeId,
      agent_type: "coder",
      tool_input: { file_path: "/tmp/foo.py" },
    });
    await hook("PostToolUse", {
      session_id: sid,
      tool_name: "Read",
      tool_use_id: "toolu_shared_1",
      agent_id: claudeId,
      agent_type: "coder",
      tool_response: { file: "ok" },
    });

    assert.equal(eventsOf(sid, "PreToolUse").filter((e) => e.tool_name === "Read").length, 1);

    // The same call as it appears in the subagent's transcript. The file name is
    // what parseSubagentFile derives agentId from, so it carries the same id the
    // hooks sent.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cai-${process.pid}-`));
    const jsonl = path.join(dir, `agent-${claudeId}.jsonl`);
    fs.writeFileSync(
      jsonl,
      [
        {
          type: "user",
          timestamp: "2026-08-12T06:11:50.000Z",
          message: { content: [{ type: "text", text: "read the file" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-08-12T06:11:52.000Z",
          message: {
            model: "claude-opus-4-7",
            content: [
              {
                type: "tool_use",
                id: "toolu_shared_1",
                name: "Read",
                input: { file_path: "/tmp/foo.py" },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
        {
          type: "user",
          timestamp: "2026-08-12T06:11:53.000Z",
          message: {
            content: [{ type: "tool_result", tool_use_id: "toolu_shared_1", content: "ok" }],
          },
        },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n")
    );
    fs.writeFileSync(
      path.join(dir, `agent-${claudeId}.meta.json`),
      JSON.stringify({ agentType: "coder" })
    );

    const parsed = await importHistory.parseSubagentFile(jsonl);
    assert.equal(parsed.agentId, claudeId, "fixture must reuse the id the hooks sent");
    importHistory.importSubagentFromJsonl(dbModule, sid, `${sid}-main`, parsed);

    const shared = db
      .prepare(
        "SELECT event_type, agent_id FROM events WHERE session_id = ? AND data LIKE ? ORDER BY id"
      )
      .all(sid, '%"tool_use_id":"toolu_shared_1"%');
    const preCount = shared.filter((e) => e.event_type === "PreToolUse").length;
    const postCount = shared.filter((e) => e.event_type === "PostToolUse").length;
    assert.equal(preCount, 1, `import re-inserted the PreToolUse (${preCount} copies)`);
    assert.equal(postCount, 1, `import re-inserted the PostToolUse (${postCount} copies)`);

    // And the subagent still exists exactly once.
    assert.equal(subagentsOf(sid).length, 1, "import must not add a parallel subagent row");
  });
});
