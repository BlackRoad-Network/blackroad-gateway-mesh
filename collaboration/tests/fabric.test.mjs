import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendJournal, readJournal, verifyJournal } from "../journal.mjs";
import { CollaborationFabric } from "../fabric.mjs";
import { createFabricJsonRpcHandler, createFabricDaemon } from "../fabric-daemon.mjs";
import { createFabricMcpHandler } from "../fabric-mcp-server.mjs";
import { callCollaboration } from "../client.mjs";

async function temporaryFabric() {
  const stateRoot = await mkdtemp(join(tmpdir(), "road-fabric-test-"));
  return new CollaborationFabric({ stateRoot });
}

test("journal records form a verifiable hash chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "road-journal-test-"));
  const path = join(root, "events.jsonl");
  const first = await appendJournal(path, { type: "first" });
  const second = await appendJournal(path, { type: "second" });
  const records = await readJournal(path);
  assert.equal(second.previousHash, first.eventHash);
  assert.deepEqual(verifyJournal(records), {
    ok: true,
    count: 2,
    headHash: second.eventHash,
    errors: []
  });
});

test("successful provider result is durable and may close its claim", async () => {
  const fabric = await temporaryFabric();
  const receipt = await fabric.submitConnectorResult({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    connector: "github",
    target: "repo:x:file:a",
    operation: "file.update",
    mode: "write",
    claimRef: "claim:1",
    status: "200 OK",
    expectedVersion: "sha:old",
    providerVersionBefore: "sha:old",
    providerVersionAfter: "sha:new",
    evidenceRefs: ["commit:sha:new"]
  });
  assert.equal(receipt.normalizedStatus, "STEP_SUCCEEDED");
  assert.equal(receipt.claimMayClose, true);
  assert.equal(receipt.secretValuesPersisted, false);
  assert.equal((await fabric.verify()).ok, true);
});

test("timeout remains unresolved and cannot close the claim", async () => {
  const fabric = await temporaryFabric();
  const receipt = await fabric.submitConnectorResult({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    connector: "netlify",
    target: "site:x",
    operation: "deploy.production",
    mode: "write",
    claimRef: "claim:1",
    status: "TIMEOUT_UNKNOWN"
  });
  assert.equal(receipt.normalizedStatus, "TIMEOUT_UNKNOWN");
  assert.equal(receipt.claimMayClose, false);
  assert.equal(receipt.requiresProviderInspection, true);
});

test("provider version drift becomes a conflict", async () => {
  const fabric = await temporaryFabric();
  const receipt = await fabric.submitConnectorResult({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    connector: "github",
    target: "repo:x:file:a",
    operation: "file.update",
    mode: "write",
    claimRef: "claim:1",
    status: "200 OK",
    expectedVersion: "sha:expected",
    providerVersionBefore: "sha:changed"
  });
  assert.equal(receipt.normalizedStatus, "CONFLICT");
  assert.equal(receipt.claimMayClose, false);
});

test("mutating result requires a claim reference", async () => {
  const fabric = await temporaryFabric();
  await assert.rejects(() => fabric.submitConnectorResult({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    connector: "github",
    target: "repo:x",
    operation: "file.update",
    mode: "write",
    status: "200 OK"
  }), { code: "CLAIM_REQUIRED" });
});

test("result channel rejects inline secret values", async () => {
  const fabric = await temporaryFabric();
  await assert.rejects(() => fabric.submitConnectorResult({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    connector: "github",
    target: "repo:x",
    operation: "metadata.read",
    mode: "read",
    status: "200 OK",
    accessToken: "forbidden"
  }), { code: "SECRET_VALUE_FORBIDDEN" });
});

test("heartbeat absence observes staleness but does not revoke authority", async () => {
  const fabric = await temporaryFabric();
  await fabric.heartbeat({
    agentId: "agent-instance-1",
    sessionId: "session-1",
    ttlSeconds: 10,
    activeClaimRefs: ["claim:device"]
  });
  const result = await fabric.listStaleSessions({ now: new Date(Date.now() + 20_000).toISOString() });
  assert.equal(result.staleCount, 1);
  assert.equal(result.sessions[0].authorityRevokedAutomatically, false);
});

test("newer heartbeat supersedes older observation", async () => {
  const fabric = await temporaryFabric();
  await fabric.heartbeat({ agentId: "agent-instance-1", sessionId: "session-1", ttlSeconds: 10 });
  await fabric.heartbeat({ agentId: "agent-instance-1", sessionId: "session-1", ttlSeconds: 3600 });
  const result = await fabric.listStaleSessions({ now: new Date(Date.now() + 20_000).toISOString() });
  assert.equal(result.staleCount, 0);
});

test("workflow status uses the latest checkpoint per step", async () => {
  const fabric = await temporaryFabric();
  await fabric.checkpointWorkflow({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    workflowId: "workflow-1",
    stepId: "source",
    state: "RUNNING"
  });
  await fabric.checkpointWorkflow({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    workflowId: "workflow-1",
    stepId: "source",
    state: "SUCCEEDED",
    receiptRef: "receipt:1"
  });
  const result = await fabric.workflowStatus("workflow-1");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].state, "SUCCEEDED");
  assert.equal(result.complete, true);
});

test("fabric daemon auto-completes only safely terminal claims", async () => {
  const fabric = await temporaryFabric();
  const calls = [];
  const handler = createFabricJsonRpcHandler({
    fabric,
    execute: async (command, params) => {
      calls.push({ command, params });
      return { command, params };
    }
  });
  const response = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "connector.result.submit",
    params: {
      agentId: "agent-instance-4",
      sessionId: "session-4",
      connector: "github",
      target: "repo:x:file:a",
      operation: "file.update",
      mode: "write",
      claimRef: "claim:1",
      status: "200 OK"
    }
  });
  assert.equal(response.result.claimCompletion.state, "COMPLETED");
  assert.equal(calls[0].command, "complete");
});

test("fabric daemon holds an unknown timeout for reconciliation", async () => {
  const fabric = await temporaryFabric();
  const calls = [];
  const handler = createFabricJsonRpcHandler({ fabric, execute: async (...args) => calls.push(args) });
  const response = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "connector.result.submit",
    params: {
      agentId: "agent-instance-4",
      sessionId: "session-4",
      connector: "netlify",
      target: "site:x",
      operation: "deploy.production",
      mode: "write",
      claimRef: "claim:1",
      status: "TIMEOUT_UNKNOWN"
    }
  });
  assert.equal(response.result.claimCompletion.state, "HELD_FOR_RECONCILIATION");
  assert.equal(calls.length, 0);
});

test("fabric daemon responds through its private Unix socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "road-fabric-daemon-test-"));
  const socketPath = join(root, "fabric.sock");
  const daemon = await createFabricDaemon({ socketPath, stateRoot: join(root, "state"), execute: async () => ({ ok: true }) });
  t.after(() => daemon.close());
  const result = await callCollaboration("fabric.verify", {}, { socketPath, timeoutMs: 1_000 });
  assert.equal(result.ok, true);
});

test("fabric MCP appends durable tools to the base collaboration surface", async () => {
  const calls = [];
  const handler = createFabricMcpHandler({
    agentId: "agent-instance-5",
    runtime: "claude",
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "collaboration.register") return { id: "session-5" };
      return { ok: true };
    }
  });
  const list = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert(list.result.tools.some((tool) => tool.name === "collaboration_report_connector_result"));
  assert(list.result.tools.some((tool) => tool.name === "collaboration_heartbeat"));

  await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "collaboration_heartbeat",
      arguments: { ttlSeconds: 90 }
    }
  });
  const heartbeat = calls.find((call) => call.method === "session.heartbeat.persist");
  assert.equal(heartbeat.params.agentId, "agent-instance-5");
  assert.equal(heartbeat.params.sessionId, "session-5");
});
