import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planDispatch } from "../dispatch.mjs";
import { planWorkflow } from "../workflow.mjs";
import { reconcileState, normalizeConnectorObservation } from "../reconcile.mjs";
import { createDaemon, createJsonRpcHandler } from "../daemon.mjs";
import { callCollaboration } from "../client.mjs";
import { createMcpHandler } from "../mcp-server.mjs";

const context = {
  profiles: {
    profiles: Array.from({ length: 6 }, (_, index) => ({
      id: `agent-instance-${index + 1}`,
      requiredGates: ["receipt"],
      allowedSkillRoutes: ["github", "netlify", "tailscale"]
    }))
  },
  connectorPolicy: {
    connectors: [
      { id: "github", expectedVersionRequired: true },
      { id: "netlify", expectedVersionRequired: true }
    ]
  },
  connectorTopology: {
    connectors: [
      { id: "github", plane: "source" },
      { id: "netlify", plane: "public-edge" }
    ]
  },
  permissionPolicy: {
    tiers: [
      { id: "metadata", gate: "read-only" },
      { id: "ordinary-write", gate: "explicit-user-intent+provider-native-auth" },
      { id: "important-write", gate: "explicit-user-intent+provider-native-auth+neura-when-sensitive" },
      { id: "public-exposure", gate: "explicit-confirmation+neura+provider-native-auth" }
    ],
    pluginOverrides: [
      { pluginId: "netlify", tier: "public-exposure" }
    ]
  }
};

test("read dispatch requires no connector claim", async () => {
  const plan = await planDispatch({
    agentId: "agent-instance-4",
    connector: "github",
    target: "repo:x",
    operation: "metadata.read",
    mode: "read"
  }, context);
  assert.equal(plan.mutating, false);
  assert.equal(plan.claimRequired, false);
  assert.equal(plan.canDispatch, true);
});

test("write dispatch is blocked without idempotency and expected version", async () => {
  const plan = await planDispatch({
    agentId: "agent-instance-4",
    connector: "github",
    target: "repo:x:file:a",
    operation: "file.update",
    mode: "write"
  }, context);
  assert.equal(plan.canDispatch, false);
  assert(plan.blockedBy.includes("idempotency_key_required"));
  assert(plan.blockedBy.includes("expected_provider_version_required"));
});

test("public deploy requires Neura receipt", async () => {
  const plan = await planDispatch({
    agentId: "agent-instance-4",
    connector: "netlify",
    target: "site:x",
    operation: "deploy.production",
    mode: "write",
    idempotencyKey: "deploy-1",
    expectedVersion: "sha:1"
  }, context);
  assert.equal(plan.neuraRequired, true);
  assert(plan.blockedBy.includes("neura_decision_receipt_required"));
});

test("inline secret values are rejected", async () => {
  await assert.rejects(() => planDispatch({
    agentId: "agent-instance-4",
    connector: "github",
    target: "x",
    operation: "read",
    apiToken: "forbidden-inline-value"
  }, context), { code: "SECRET_VALUE_FORBIDDEN" });
});

test("workflow serializes independent writes to the same resource", async () => {
  const plan = await planWorkflow({
    agentId: "agent-instance-4",
    steps: [
      {
        id: "a",
        connector: "github",
        target: "repo:x:file:a",
        operation: "file.update",
        mode: "write",
        idempotencyKey: "a",
        expectedVersion: "1",
        delegationRef: "delegation:1"
      },
      {
        id: "b",
        connector: "github",
        target: "repo:x:file:a",
        operation: "file.update",
        mode: "write",
        idempotencyKey: "b",
        expectedVersion: "2",
        delegationRef: "delegation:1"
      }
    ]
  }, context);
  assert.equal(plan.inferredDependencies.length, 1);
  assert.deepEqual(plan.waves, [["a"], ["b"]]);
});

test("workflow cycle is refused", async () => {
  await assert.rejects(() => planWorkflow({
    agentId: "agent-instance-4",
    steps: [
      { id: "a", connector: "github", target: "a", operation: "read", dependsOn: ["b"] },
      { id: "b", connector: "github", target: "b", operation: "read", dependsOn: ["a"] }
    ]
  }, context), { code: "WORKFLOW_CYCLE" });
});

test("cross-domain mutation creates a handoff requirement", async () => {
  const plan = await planWorkflow({
    agentId: "agent-instance-4",
    steps: [{
      id: "dns",
      connector: "github",
      target: "domain:gateway.blackroad.io",
      operation: "dns.publish",
      mode: "write",
      idempotencyKey: "dns",
      expectedVersion: "1",
      decisionReceiptRef: "decision:1"
    }]
  }, context);
  assert.equal(plan.handoffs[0].toAgent, "agent-instance-3");
});

test("timeout remains unknown and forbids blind retry", () => {
  const result = normalizeConnectorObservation({ status: "timeout" });
  assert.equal(result.normalizedStatus, "TIMEOUT_UNKNOWN");
  assert.equal(result.retrySafe, false);
});

test("successful empty read is an empty observation", () => {
  const result = normalizeConnectorObservation({ status: "200 OK", items: [] });
  assert.equal(result.normalizedStatus, "EMPTY_OBSERVATION");
});

test("reconciliation demands provider verification before retry", () => {
  const result = reconcileState({ operations: [{ id: "op-1", state: "TIMEOUT_UNKNOWN" }] });
  assert.equal(result.actions[0].action, "VERIFY_PROVIDER_BEFORE_RETRY");
});

test("JSON-RPC handler exposes planner without provider mutation", async () => {
  const handler = createJsonRpcHandler({
    dispatchContext: context,
    execute: async () => ({ ok: true })
  });
  const response = await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "dispatch.plan",
    params: {
      agentId: "agent-instance-4",
      connector: "github",
      target: "repo:x",
      operation: "metadata.read",
      mode: "read"
    }
  });
  assert.equal(response.result.canDispatch, true);
});

test("Unix socket daemon responds to ping", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "road-collab-test-"));
  const socketPath = join(directory, "collab.sock");
  const daemon = await createDaemon({
    socketPath,
    dispatchContext: context,
    execute: async () => ({ ok: true })
  });
  t.after(() => daemon.close());
  const result = await callCollaboration("ping", {}, { socketPath, timeoutMs: 1_000 });
  assert.equal(result.ok, true);
});

test("MCP lists first-class collaboration tools", async () => {
  const handler = createMcpHandler({
    agentId: "agent-instance-4",
    call: async () => ({ id: "session-1" })
  });
  const response = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert(response.result.tools.some((tool) => tool.name === "collaboration_workflow_plan"));
  assert(response.result.tools.some((tool) => tool.name === "collaboration_claim"));
});

test("MCP planner injects stable agent and ephemeral session", async () => {
  const calls = [];
  const handler = createMcpHandler({
    agentId: "agent-instance-5",
    runtime: "claude",
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "collaboration.register") return { id: "session-5" };
      return { ok: true };
    }
  });
  await handler({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "collaboration_plan",
      arguments: { connector: "github", target: "repo:x", operation: "metadata.read" }
    }
  });
  assert.equal(calls[1].params.agentId, "agent-instance-5");
  assert.equal(calls[1].params.sessionId, "session-5");
});
