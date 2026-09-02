import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStateStore } from "../lib/store.mjs";
import { CollaborationBroker } from "../lib/broker.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "road-collab-mcp-"));
  const templatesPath = join(dir, "templates.json");
  await writeFile(templatesPath, JSON.stringify({
    templates: [{
      id: "code-to-deploy",
      integrationOwnerAgent: "agent-instance-4",
      participants: ["agent-instance-2", "agent-instance-4"],
      steps: [
        {
          id: "source",
          connectorProfile: "source-control",
          actionClass: "WRITE",
          owner: "agent-instance-2",
          dependsOn: [],
          resourceKey: "git://repo/config"
        },
        {
          id: "deploy",
          connectorProfile: "hosting-deploy",
          actionClass: "DEPLOY",
          owner: "agent-instance-4",
          dependsOn: ["source"],
          requiresVerifiedDependencies: true,
          resourceKey: "netlify://site/deploy"
        }
      ]
    }]
  }));

  const broker = new CollaborationBroker({
    store: new JsonStateStore({ statePath: join(dir, "state.json") }),
    templatesPath,
    heartbeatTtlSeconds: 3600
  });

  await broker.heartbeat({ agentId: "agent-instance-2", sessionRef: "a2-one" });
  await broker.heartbeat({ agentId: "agent-instance-2", sessionRef: "a2-two" });
  await broker.heartbeat({ agentId: "agent-instance-4", sessionRef: "a4-one" });
  return { broker, dir };
}

async function instantiated(broker) {
  return broker.instantiateWorkflow({
    agentId: "agent-instance-4",
    sessionRef: "a4-one",
    templateId: "code-to-deploy",
    workflowId: "wf-test",
    idempotencyKey: "wf-test-key"
  });
}

test("template instantiation creates ready source and blocked deploy", async () => {
  const { broker } = await fixture();
  const result = await instantiated(broker);
  assert.equal(result.workItems.find((item) => item.stepId === "source").state, "READY");
  assert.equal(result.workItems.find((item) => item.stepId === "deploy").state, "BLOCKED");
});

test("idempotent workflow retry returns same workflow and changed request is rejected", async () => {
  const { broker } = await fixture();
  const first = await instantiated(broker);
  const second = await instantiated(broker);
  assert.equal(first.workflow.id, second.workflow.id);
  await assert.rejects(
    () => broker.instantiateWorkflow({
      agentId: "agent-instance-4",
      sessionRef: "a4-one",
      templateId: "code-to-deploy",
      workflowId: "wf-other",
      idempotencyKey: "wf-test-key",
      parameters: { changed: true }
    }),
    /workflow-idempotency-conflict/
  );
});

test("successful mutation requires verification and unlocks dependent queue", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  const source = (await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" }))[0];
  await broker.startWorkItem({ agentId: "agent-instance-2", sessionRef: "a2-one", workItemId: source.id });
  await assert.rejects(
    () => broker.finishWorkItem({
      agentId: "agent-instance-2",
      sessionRef: "a2-one",
      workItemId: source.id,
      outcome: "SUCCEEDED"
    }),
    /verified-readback-required/
  );
  await broker.finishWorkItem({
    agentId: "agent-instance-2",
    sessionRef: "a2-one",
    workItemId: source.id,
    outcome: "SUCCEEDED",
    verificationRef: "github-readback:sha",
    observedResourceVersionRef: "sha:abc"
  });
  const deploy = (await broker.queue({ agentId: "agent-instance-4", sessionRef: "a4-one" }))
    .find((item) => item.stepId === "deploy");
  assert.equal(deploy.state, "READY");
});

test("another session under the same logical agent cannot finish owned work", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  const source = (await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" }))[0];
  await broker.startWorkItem({ agentId: "agent-instance-2", sessionRef: "a2-one", workItemId: source.id });
  await assert.rejects(
    () => broker.finishWorkItem({
      agentId: "agent-instance-2",
      sessionRef: "a2-two",
      workItemId: source.id,
      outcome: "FAILED"
    }),
    /work-item-session-mismatch/
  );
});

test("delegation changes ownership only after target acceptance", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  const source = (await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" }))[0];
  const delegation = await broker.createDelegation({
    agentId: "agent-instance-2",
    sessionRef: "a2-one",
    workItemId: source.id,
    toAgentId: "agent-instance-4",
    contractRef: "road://contract/source-review",
    acceptanceRefs: ["test://source"],
    idempotencyKey: "delegate-source"
  });
  assert.equal((await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" })).length, 1);
  await broker.resolveDelegation({
    agentId: "agent-instance-4",
    sessionRef: "a4-one",
    delegationId: delegation.id,
    decision: "ACCEPTED",
    resultRef: "acceptance://ok"
  });
  assert.equal((await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" })).length, 0);
  assert.equal(
    (await broker.queue({ agentId: "agent-instance-4", sessionRef: "a4-one" }))
      .filter((item) => item.id === source.id).length,
    1
  );
});

test("timeout unknown does not unlock dependent work", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  const source = (await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" }))[0];
  await broker.startWorkItem({ agentId: "agent-instance-2", sessionRef: "a2-one", workItemId: source.id });
  await broker.finishWorkItem({
    agentId: "agent-instance-2",
    sessionRef: "a2-one",
    workItemId: source.id,
    outcome: "TIMEOUT_UNKNOWN",
    resultRef: "provider://unknown"
  });
  const deploy = (await broker.queue({ agentId: "agent-instance-4", sessionRef: "a4-one" }))
    .find((item) => item.stepId === "deploy");
  assert.equal(deploy.state, "BLOCKED");
});

test("notification acknowledgement is target and session bound", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  const notifications = await broker.notifications({ agentId: "agent-instance-2", sessionRef: "a2-one" });
  assert.ok(notifications.length >= 1);
  await assert.rejects(
    () => broker.acknowledgeNotification({
      agentId: "agent-instance-4",
      sessionRef: "a4-one",
      notificationId: notifications[0].id
    }),
    /notification-target-mismatch/
  );
  const acknowledged = await broker.acknowledgeNotification({
    agentId: "agent-instance-2",
    sessionRef: "a2-one",
    notificationId: notifications[0].id
  });
  assert.equal(acknowledged.state, "ACKNOWLEDGED");
  assert.equal(acknowledged.acknowledgedBySessionRef, "a2-one");
});

test("secret-like values are rejected before entering durable state", async () => {
  const { broker } = await fixture();
  await assert.rejects(
    () => broker.instantiateWorkflow({
      agentId: "agent-instance-4",
      sessionRef: "a4-one",
      templateId: "code-to-deploy",
      workflowId: "wf-secret",
      idempotencyKey: "wf-secret",
      parameters: { credential: `sk-${"x".repeat(24)}` }
    }),
    /secret-value-rejected/
  );
});

test("concurrent starts serialize and permit only one exclusive mutation per agent", async () => {
  const { broker } = await fixture();
  await instantiated(broker);
  await broker.instantiateWorkflow({
    agentId: "agent-instance-4",
    sessionRef: "a4-one",
    templateId: "code-to-deploy",
    workflowId: "wf-two",
    idempotencyKey: "wf-two-key"
  });
  const items = await broker.queue({ agentId: "agent-instance-2", sessionRef: "a2-one" });
  const results = await Promise.allSettled(
    items.map((item) => broker.startWorkItem({
      agentId: "agent-instance-2",
      sessionRef: "a2-one",
      workItemId: item.id
    }))
  );
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  assert.match(String(results.find((entry) => entry.status === "rejected").reason), /agent-exclusive-mutation-limit/);
});
