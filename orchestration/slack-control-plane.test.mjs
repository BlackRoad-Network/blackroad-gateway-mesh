import test from "node:test";
import assert from "node:assert/strict";

import {
  COCKPIT,
  buildReceipt,
  normalizeGitHubPullRequestEvent,
  normalizeSlackEvent,
  parseRoadCommand,
  planGitHubSlackDelivery,
  planSlackCommandIntake,
  planOllamaDispatch
} from "./slack-control-plane.mjs";

const RECEIPT_BASE = Object.freeze({
  id: "receipt-1729",
  intentId: "intent-1729",
  agentId: "connector-orchestrator",
  connectorId: "slack",
  actionClass: "COMMUNICATE",
  resourceKey: "slack:channel:C0A2M4K8WLB",
  recordedAt: "2026-09-11T00:00:00Z"
});
const receipt = (values = {}) => buildReceipt({ ...RECEIPT_BASE, ...values });
const resolvedPlan = (id, values = {}) => ({
  id,
  actionClass: "WRITE",
  resourceKey: `road:plan:${id}`,
  planHash: `sha256:${"a".repeat(64)}`,
  risk: [],
  ...values
});

test("non-boolean evidence cannot complete an operation receipt", () => {
  for (const value of ["false", "true", 1, [], {}]) {
    assert.equal(receipt({ providerAcknowledged: value, readBackVerified: true }).outcome, "SUCCEEDED");
    assert.equal(receipt({ providerAcknowledged: true, readBackVerified: value }).outcome, "PARTIAL");
  }
});

test("private listener evidence must be explicitly true", () => {
  for (const privateListener of ["false", "true", 1, [], {}]) {
    const result = planOllamaDispatch({
      tailnetNodeIdentity: "olympia",
      serviceOwnership: "svc:models",
      privateListener,
      modelInventory: ["model-a"],
      boundedInference: true
    });
    assert.equal(result.state, "BLOCKED_OFFLINE");
    assert.deepEqual(result.missing, ["privateListener"]);
  }
});

test("rejects non-Road input", () => {
  assert.equal(parseRoadCommand("hello").state, "BLOCKED_UNKNOWN_COMMAND");
});

test("rejects a command without an exact target", () => {
  assert.equal(parseRoadCommand("road status").state, "BLOCKED_MISSING_TARGET");
});

test("accepts a bounded read", () => {
  const result = parseRoadCommand("road status github");
  assert.equal(result.accepted, true);
  assert.equal(result.actionClass, "READ");
  assert.equal(result.requiresApproval, false);
});

test("rejects secret-like material without returning the target", () => {
  const result = parseRoadCommand(
    "road run github token=github_pat_abcdefghijklmnopqrstuvwxyz1234"
  );
  assert.equal(result.accepted, false);
  assert.equal(result.state, "BLOCKED_SECRET_MATERIAL");
  assert.equal("target" in result, false);
});

test("rejects generic API keys and raw AWS access-key identifiers", () => {
  for (const text of [
    "road run api_key=private-value-1729",
    "road run access-key=private-value-1729",
    "road run AKIA1234567890ABCDEF"
  ]) {
    const result = parseRoadCommand(text);
    assert.equal(result.state, "BLOCKED_SECRET_MATERIAL");
    assert.equal("target" in result, false);
  }
});

test("handoff requires and preserves both owner and operation", () => {
  assert.equal(parseRoadCommand("road handoff agent-instance-2").state, "BLOCKED_INVALID_HANDOFF");
  assert.equal(parseRoadCommand("road handoff unknown-agent verify connector health").state, "BLOCKED_INVALID_HANDOFF");
  const command = parseRoadCommand("road handoff agent-instance-2 verify connector health");
  assert.equal(command.actionClass, "COMMUNICATE");
  assert.deepEqual(command.handoff, { owner: "agent-instance-2", operation: "verify connector health" });
});

test("administrative verbs require strong approval independent of target wording", () => {
  for (const text of ["road stop operation-1729", "road reconcile operation-1729"]) {
    const command = parseRoadCommand(text);
    assert.equal(command.actionClass, "ADMIN");
    assert.equal(command.requiresStrongApproval, true);
    assert.ok(command.risk.includes("ADMIN"));
  }
});

test("risk matching uses complete word boundaries", () => {
  assert.deepEqual(parseRoadCommand("road status relationship").risk, []);
  assert.deepEqual(parseRoadCommand("road status release candidate").risk, ["DEPLOY"]);
});

test("requires strong approval for deployment or public exposure", () => {
  const result = parseRoadCommand("road run deploy the public route");
  assert.equal(result.state, "AWAITING_AUTHORIZATION");
  assert.equal(result.requiresStrongApproval, true);
  assert.deepEqual(result.risk.sort(), ["DEPLOY", "PUBLIC_EXPOSURE"]);
});

test("normalizes an authorized Slack command without persisting raw content", () => {
  const event = {
    event_id: "Ev01",
    ts: "1788943756.716919",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road status github"
  };
  const first = normalizeSlackEvent(event);
  const second = normalizeSlackEvent(event);

  assert.equal(first.accepted, true);
  assert.equal(first.rawContentPersisted, false);
  assert.equal(first.contentHash.startsWith("sha256:"), true);
  assert.equal(first.canonicalEventId, second.canonicalEventId);
});

test("ignores a command from another channel", () => {
  const result = normalizeSlackEvent({
    event_id: "Ev02",
    ts: "2",
    channel: "C_OTHER",
    user: COCKPIT.operatorUserId,
    text: "road status github"
  });
  assert.equal(result.state, "IGNORED_WRONG_CHANNEL");
});

test("ignores a command from another author", () => {
  const result = normalizeSlackEvent({
    event_id: "Ev03",
    ts: "3",
    channel: COCKPIT.channelId,
    user: "U_OTHER",
    text: "road status github"
  });
  assert.equal(result.state, "IGNORED_UNAUTHORIZED_AUTHOR");
});

test("ignores bot self-echo", () => {
  const result = normalizeSlackEvent({
    event_id: "Ev04",
    ts: "4",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    bot_id: "B_SELF",
    text: "road status github"
  });
  assert.equal(result.state, "IGNORED_SELF_ECHO");
});

test("keeps Slack command intake blocked until inbound is verified", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-blocked",
    ts: "1788946000.123456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road status github"
  });
  const plan = planSlackCommandIntake(event);
  assert.equal(plan.state, "BLOCKED_INBOUND_UNVERIFIED");
  assert.equal(plan.shouldDispatch, false);
});

test("plans a verified read in the exact Slack thread", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-read",
    ts: "1788946001.123456",
    thread_ts: "1788945900.654321",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road status github"
  });
  const plan = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true
  });
  assert.equal(plan.state, "READY_TO_DISPATCH");
  assert.equal(plan.actionClass, "READ");
  assert.equal(plan.operationThreadTs, "1788945900.654321");
  assert.equal(plan.rawContentPersisted, false);
  assert.deepEqual(plan.automaticProviderMutations, []);
});

test("deduplicates a recorded Slack command", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-once",
    ts: "1788946002.123456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road status tailscale"
  });
  const plan = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true,
    seenCanonicalEventIds: [event.canonicalEventId]
  });
  assert.equal(plan.state, "NOOP_DUPLICATE_COMMAND");
  assert.equal(plan.shouldDispatch, false);
});

test("binds approval to the command hash, event, and thread", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-run",
    ts: "1788946003.123456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road run approved-plan-1729"
  });
  const plans = { "approved-plan-1729": resolvedPlan("approved-plan-1729") };
  const waiting = planSlackCommandIntake(event, { inboundSubscriptionVerified: true, resolvedPlansById: plans });
  const stale = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true, resolvedPlansById: plans,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: "sha256:stale",
      threadTs: event.thread
    }
  });
  const approved = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true, resolvedPlansById: plans,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: event.contentHash,
      threadTs: event.thread,
      planHash: waiting.resolvedPlanHash
    }
  });
  assert.equal(stale.state, "AWAITING_AUTHORIZATION");
  assert.equal(approved.state, "READY_TO_DISPATCH");
});

test("run commands fail closed until the referenced plan is resolved", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-unresolved-plan",
    ts: "1788946003.223456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road run approved-plan-1729"
  });
  assert.equal(planSlackCommandIntake(event, { inboundSubscriptionVerified: true }).state, "BLOCKED_PLAN_UNRESOLVED");
  assert.equal(planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true,
    resolvedPlansById: {
      "approved-plan-1729": { ...resolvedPlan("approved-plan-1729"), planHash: "sha256:bad" }
    }
  }).state, "BLOCKED_INVALID_PLAN");
});

test("requires strong approval for high-risk Slack commands", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-deploy",
    ts: "1788946004.123456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road run deployment-plan-1729"
  });
  const resolvedPlansById = {
    "deployment-plan-1729": resolvedPlan("deployment-plan-1729", { actionClass: "DEPLOY" })
  };
  const waiting = planSlackCommandIntake(event, { inboundSubscriptionVerified: true, resolvedPlansById });
  const weak = {
    inboundSubscriptionVerified: true,
    resolvedPlansById,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: event.contentHash,
      threadTs: event.thread,
      strength: "NORMAL",
      planHash: waiting.resolvedPlanHash
    }
  };
  assert.equal(
    planSlackCommandIntake(event, weak).state,
    "AWAITING_STRONG_AUTHORIZATION"
  );
  assert.equal(
    planSlackCommandIntake(event, {
      ...weak,
      approval: { ...weak.approval, strength: "STRONG" }
    }).state,
    "READY_TO_DISPATCH"
  );
});

test("run dispatch uses the resolved plan action class and binds its hash", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-resolved-plan",
    ts: "1788946004.223456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road run deployment-plan-1729"
  });
  const resolvedPlansById = {
    "deployment-plan-1729": resolvedPlan("deployment-plan-1729", { actionClass: "DEPLOY" })
  };
  const waiting = planSlackCommandIntake(event, { inboundSubscriptionVerified: true, resolvedPlansById });
  const approval = {
    approved: true,
    strength: "STRONG",
    canonicalEventId: event.canonicalEventId,
    contentHash: event.contentHash,
    threadTs: event.thread,
    planHash: waiting.resolvedPlanHash
  };
  const plan = planSlackCommandIntake(event, { inboundSubscriptionVerified: true, resolvedPlansById, approval });
  assert.equal(plan.state, "READY_TO_DISPATCH");
  assert.equal(plan.actionClass, "DEPLOY");
  assert.equal(plan.resolvedPlanHash, approval.planHash);
});

test("routes only canonical gateway pull-request events", () => {
  const accepted = normalizeGitHubPullRequestEvent({
    action: "synchronize",
    delivery_id: "delivery-1",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 12 }
  });
  const rejected = normalizeGitHubPullRequestEvent({
    action: "opened",
    delivery_id: "delivery-2",
    repository: { full_name: "other/repo" },
    pull_request: { number: 1 }
  });

  assert.equal(accepted.state, "READY_TO_REPORT");
  assert.equal(accepted.marker, "[github:BlackRoad-Network/blackroad-gateway-mesh#12]");
  assert.deepEqual(accepted.automaticProviderMutations, []);
  assert.equal(rejected.state, "IGNORED_WRONG_REPOSITORY");
});

test("accepts provider-normalized lowercase repository names", () => {
  const result = normalizeGitHubPullRequestEvent({
    action: "opened",
    delivery_id: "delivery-lowercase",
    repository: { full_name: COCKPIT.githubRepository.toLowerCase() },
    pull_request: { number: 14 }
  });

  assert.equal(result.state, "READY_TO_REPORT");
  assert.equal(result.source.repository, COCKPIT.githubRepository);
  assert.equal(result.marker, "[github:BlackRoad-Network/blackroad-gateway-mesh#14]");
});

test("classifies closed pull requests by merged state", () => {
  const baseEvent = {
    action: "closed",
    delivery_id: "delivery-closed",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15 }
  };

  assert.equal(
    normalizeGitHubPullRequestEvent(baseEvent).classification,
    "CLOSED"
  );
  assert.equal(
    normalizeGitHubPullRequestEvent({
      ...baseEvent,
      delivery_id: "delivery-merged",
      pull_request: { ...baseEvent.pull_request, merged: true }
    }).classification,
    "MERGED"
  );
});

test("blocks unsupported pull-request actions", () => {
  const result = normalizeGitHubPullRequestEvent({
    action: "mystery_action",
    delivery_id: "delivery-unknown",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15 }
  });

  assert.equal(result.accepted, false);
  assert.equal(result.state, "BLOCKED_UNSUPPORTED_ACTION");
});

test("deduplicates semantic redeliveries while retaining delivery identity", () => {
  const event = {
    action: "synchronize",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: {
      number: 15,
      head: { sha: "abc123" },
      updated_at: "2026-09-09T09:07:51Z"
    }
  };
  const first = normalizeGitHubPullRequestEvent({
    ...event,
    delivery_id: "delivery-a"
  });
  const redelivery = normalizeGitHubPullRequestEvent({
    ...event,
    delivery_id: "delivery-b"
  });

  assert.equal(first.classification, "UPDATED");
  assert.equal(first.semanticIdempotencyKey, redelivery.semanticIdempotencyKey);
  assert.notEqual(first.deliveryIdempotencyKey, redelivery.deliveryIdempotencyKey);
});

test("metadata-only PR actions receive distinct semantic revisions on the same head", () => {
  const base = {
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15, head: { sha: "same-head" }, updated_at: "2026-09-11T00:00:00Z" }
  };
  const edited = normalizeGitHubPullRequestEvent({ ...base, action: "edited", delivery_id: "delivery-edit" });
  const reopened = normalizeGitHubPullRequestEvent({ ...base, action: "reopened", delivery_id: "delivery-reopen" });
  const laterEdit = normalizeGitHubPullRequestEvent({
    ...base,
    action: "edited",
    delivery_id: "delivery-edit-later",
    pull_request: { ...base.pull_request, updated_at: "2026-09-11T00:01:00Z" }
  });
  assert.notEqual(edited.semanticIdempotencyKey, reopened.semanticIdempotencyKey);
  assert.notEqual(edited.semanticIdempotencyKey, laterEdit.semanticIdempotencyKey);
});

test("plans one parent and later events in its exact thread", () => {
  const opened = normalizeGitHubPullRequestEvent({
    action: "opened",
    delivery_id: "delivery-parent",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15, head: { sha: "head-a" } }
  });
  const parentPlan = planGitHubSlackDelivery(opened);

  assert.equal(parentPlan.mode, "PARENT");
  assert.equal(parentPlan.threadTs, null);
  assert.equal(parentPlan.channelId, COCKPIT.channelId);

  const updated = normalizeGitHubPullRequestEvent({
    action: "synchronize",
    delivery_id: "delivery-thread",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15, head: { sha: "head-b" } }
  });
  const threadPlan = planGitHubSlackDelivery(updated, {
    parentsByMarker: { [updated.marker]: "1788944931.111459" }
  });

  assert.equal(threadPlan.mode, "THREAD");
  assert.equal(threadPlan.threadTs, "1788944931.111459");
});

test("turns recorded deliveries and semantic redeliveries into no-ops", () => {
  const event = normalizeGitHubPullRequestEvent({
    action: "synchronize",
    delivery_id: "delivery-once",
    repository: { full_name: COCKPIT.githubRepository },
    pull_request: { number: 15, head: { sha: "same-head" } }
  });

  const deliveryDuplicate = planGitHubSlackDelivery(event, {
    seenDeliveryKeys: [event.deliveryIdempotencyKey]
  });
  const semanticDuplicate = planGitHubSlackDelivery(event, {
    seenSemanticKeys: [event.semanticIdempotencyKey]
  });

  assert.equal(deliveryDuplicate.state, "NOOP_DUPLICATE_DELIVERY");
  assert.equal(deliveryDuplicate.shouldPost, false);
  assert.equal(semanticDuplicate.state, "NOOP_DUPLICATE_SEMANTIC_EVENT");
  assert.equal(semanticDuplicate.shouldPost, false);
});

test("refuses to plan a rejected or malformed provider event", () => {
  const plan = planGitHubSlackDelivery({
    accepted: false,
    kind: "GITHUB_PULL_REQUEST_EVENT"
  });

  assert.equal(plan.state, "BLOCKED_INVALID_EVENT");
  assert.equal(plan.shouldPost, false);
});

test("keeps Ollama blocked until every private-route proof exists", () => {
  const result = planOllamaDispatch({
    tailnetNodeIdentity: "olympia",
    serviceOwnership: "svc:models",
    privateListener: true,
    modelInventory: ["model-a"]
  });

  assert.equal(result.state, "BLOCKED_OFFLINE");
  assert.deepEqual(result.missing, ["boundedInference"]);
  assert.equal(result.publicFallback, false);
  assert.equal(result.paidFallback, false);
});

test("marks Ollama ready only with complete private evidence", () => {
  const result = planOllamaDispatch({
    tailnetNodeIdentity: "olympia",
    serviceOwnership: "svc:models",
    privateListener: true,
    modelInventory: ["model-a"],
    boundedInference: true
  });

  assert.equal(result.state, "READY_PRIVATE");
  assert.deepEqual(result.verifiedModels, ["model-a"]);
  assert.equal(result.visibility, "tailnet-only");
});

test("provider acknowledgement alone is not completion", () => {
  assert.equal(
    receipt({ providerAcknowledged: true, readBackVerified: false }).outcome,
    "PARTIAL"
  );
  assert.equal(
    receipt({ providerAcknowledged: true, readBackVerified: true }).outcome,
    "SUCCEEDED"
  );
});

test("unknown timeouts require reconciliation and cannot auto-retry", () => {
  const result = receipt({
    providerAcknowledged: false,
    readBackVerified: false,
    timeoutUnknown: true
  });

  assert.equal(result.outcome, "TIMEOUT_UNKNOWN");
});

test("verified reconciliation succeeds without fabricating provider acknowledgement", () => {
  assert.equal(receipt({ providerAcknowledged: false, readBackVerified: true, timeoutUnknown: true }).outcome, "SUCCEEDED");
});

test("operation receipts contain only collaboration receipt contract fields", () => {
  const result = receipt({
    providerAcknowledged: true,
    readBackVerified: true,
    invocationId: "invocation-1729",
    sessionRef: "session-1729",
    evidenceRefs: ["evidence-1729"]
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "actionClass", "agentId", "claimId", "connectorId", "decisionReceiptRef", "errorClass",
    "evidenceRefs", "id", "intentId", "invocationId", "outcome", "providerRequestRef",
    "recordedAt", "resourceKey", "sessionRef", "summary", "validationRefs", "workflowId"
  ].sort());
  assert.equal(result.outcome, "SUCCEEDED");
  assert.equal("state" in result, false);
  assert.equal("retryAllowed" in result, false);
});
