import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorAdapterRegistry, executeDispatchPlan, runWorkflowPlan } from "../execution.mjs";
import { planDispatch } from "../dispatch.mjs";
import { planWorkflow } from "../workflow.mjs";

const context = {
  profiles: { profiles: Array.from({ length: 6 }, (_, index) => ({ id: `agent-instance-${index + 1}`, requiredGates: ["receipt"] })) },
  connectorPolicy: { connectors: [{ id: "github", expectedVersionRequired: true }, { id: "airtable", expectedVersionRequired: true }] },
  connectorTopology: { connectors: [{ id: "github", plane: "source" }, { id: "airtable", plane: "registry" }] },
  permissionPolicy: { tiers: [{ id: "metadata", gate: "read-only" }, { id: "ordinary-write", gate: "explicit-user-intent+provider-native-auth" }], pluginOverrides: [] }
};

function adapters() {
  return new ConnectorAdapterRegistry()
    .register("github", { execute: async (request) => ({ status: "200 OK", providerVersionBefore: request.expectedVersion, providerVersionAfter: "sha:next", evidenceRefs: ["github:receipt"] }) })
    .register("airtable", { execute: async (request) => ({ status: "200 OK", providerVersionBefore: request.expectedVersion, providerVersionAfter: "rev:next", evidenceRefs: ["airtable:receipt"] }) });
}

test("adapter registration refuses duplicate connector ownership", () => {
  const registry = new ConnectorAdapterRegistry().register("github", { execute: async () => ({ status: "OK" }) });
  assert.throws(() => registry.register("github", { execute: async () => ({ status: "OK" }) }), { code: "ADAPTER_CONFLICT" });
});

test("mutating dispatch refuses execution without claim", async () => {
  const plan = await planDispatch({ agentId: "agent-instance-4", sessionId: "session-4", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "key", expectedVersion: "sha:old" }, context);
  await assert.rejects(() => executeDispatchPlan({ plan, adapters: adapters() }), { code: "CLAIM_REQUIRED" });
});

test("known provider success produces a closeable causal receipt", async () => {
  const plan = await planDispatch({ agentId: "agent-instance-4", sessionId: "session-4", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "key", expectedVersion: "sha:old" }, context);
  const receipt = await executeDispatchPlan({ plan, adapters: adapters(), claimRef: "claim:1" });
  assert.equal(receipt.normalizedStatus, "STEP_SUCCEEDED");
  assert.equal(receipt.claimMayClose, true);
  assert.equal(receipt.secretValuesPersisted, false);
});

test("provider version mismatch is a conflict and keeps claim unresolved", async () => {
  const registry = new ConnectorAdapterRegistry().register("github", { execute: async () => ({ status: "200 OK", providerVersionBefore: "sha:changed" }) });
  const plan = await planDispatch({ agentId: "agent-instance-4", sessionId: "session-4", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "key", expectedVersion: "sha:old" }, context);
  const receipt = await executeDispatchPlan({ plan, adapters: registry, claimRef: "claim:1" });
  assert.equal(receipt.normalizedStatus, "CONFLICT");
  assert.equal(receipt.claimMayClose, false);
});

test("timeout remains unknown and does not close the claim", async () => {
  const registry = new ConnectorAdapterRegistry().register("github", { execute: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } });
  const plan = await planDispatch({ agentId: "agent-instance-4", sessionId: "session-4", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "key", expectedVersion: "sha:old" }, context);
  const receipt = await executeDispatchPlan({ plan, adapters: registry, claimRef: "claim:1" });
  assert.equal(receipt.normalizedStatus, "TIMEOUT_UNKNOWN");
  assert.equal(receipt.requiresReconciliation, true);
  assert.equal(receipt.claimMayClose, false);
});

test("inline connector secret values are refused", async () => {
  const registry = new ConnectorAdapterRegistry().register("github", { execute: async () => ({ status: "OK", apiToken: "forbidden" }) });
  const plan = await planDispatch({ agentId: "agent-instance-4", connector: "github", target: "repo:x", operation: "metadata.read", mode: "read" }, context);
  await assert.rejects(() => executeDispatchPlan({ plan, adapters: registry }), { code: "SECRET_VALUE_FORBIDDEN" });
});

test("multi-connector workflow executes dependency-safe waves", async () => {
  const workflow = await planWorkflow({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    steps: [
      { id: "source", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "source", expectedVersion: "sha:old" },
      { id: "index", connector: "airtable", target: "base:x:record:a", operation: "record.update", mode: "write", idempotencyKey: "index", expectedVersion: "rev:old", dependsOn: ["source"] }
    ]
  }, context);
  const completed = [];
  const result = await runWorkflowPlan({
    workflow,
    adapters: adapters(),
    acquireClaim: async (plan) => `claim:${plan.planId}`,
    completeClaim: async (_plan, claim) => completed.push(claim)
  });
  assert.equal(result.complete, true);
  assert.equal(result.receipts.length, 2);
  assert.equal(completed.length, 2);
});

test("workflow stops after an unknown timeout", async () => {
  const registry = new ConnectorAdapterRegistry()
    .register("github", { execute: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } })
    .register("airtable", { execute: async () => ({ status: "200 OK" }) });
  const workflow = await planWorkflow({
    agentId: "agent-instance-4",
    sessionId: "session-4",
    steps: [
      { id: "source", connector: "github", target: "repo:x:file:a", operation: "file.update", mode: "write", idempotencyKey: "source", expectedVersion: "sha:old" },
      { id: "index", connector: "airtable", target: "base:x:record:a", operation: "record.update", mode: "write", idempotencyKey: "index", expectedVersion: "rev:old", dependsOn: ["source"] }
    ]
  }, context);
  const result = await runWorkflowPlan({ workflow, adapters: registry, acquireClaim: async () => "claim:1" });
  assert.equal(result.complete, false);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].receipt.normalizedStatus, "TIMEOUT_UNKNOWN");
});
