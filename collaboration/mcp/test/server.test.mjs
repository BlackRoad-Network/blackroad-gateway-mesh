import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function waitForLines(child, expected, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const values = [];
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error(`timed-out:${values.length}/${expected}`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        values.push(JSON.parse(line));
        if (values.length === expected) {
          clearTimeout(timeout);
          resolvePromise(values);
        }
      }
    });
    child.on("exit", (code) => {
      if (values.length < expected) reject(new Error(`server-exited:${code}`));
    });
  });
}

test("stdio server preserves request order and binds tools to configured actor session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "road-collab-server-"));
  const templates = join(dir, "templates.json");
  await writeFile(templates, JSON.stringify({
    templates: [{
      id: "one",
      integrationOwnerAgent: "agent-instance-4",
      participants: ["agent-instance-4"],
      steps: [{
        id: "read",
        connectorProfile: "internal-service",
        actionClass: "READ",
        owner: "agent-instance-4",
        dependsOn: []
      }]
    }]
  }));

  const child = spawn(process.execPath, [resolve("server.mjs")], {
    cwd: resolve("collaboration/mcp"),
    env: {
      ...process.env,
      ROAD_AGENT_ID: "agent-instance-4",
      ROAD_SESSION_REF: "server-session",
      ROAD_COLLAB_MCP_STATE: join(dir, "state.json"),
      ROAD_COLLAB_TEMPLATES: templates,
      ROAD_MCP_NDJSON: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const responsePromise = waitForLines(child, 5);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "test-v1" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "road_collab_session_heartbeat", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "road_collab_workflow_instantiate", arguments: { templateId: "one", workflowId: "wf-server", idempotencyKey: "wf-server-key" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "road_collab_queue_list", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }
  ];

  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const responses = await responsePromise;
  child.kill();

  assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, 4, 5]);
  assert.match(responses[3].result.content[0].text, /wf-server:read/);
  const toolNames = responses[4].result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("road_collab_workflow_instantiate"));
  assert.ok(toolNames.includes("road_collab_delegation_create"));
});
