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
  const stale = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: "sha256:stale",
      threadTs: event.thread
    }
  });
  const approved = planSlackCommandIntake(event, {
    inboundSubscriptionVerified: true,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: event.contentHash,
      threadTs: event.thread
    }
  });
  assert.equal(stale.state, "AWAITING_AUTHORIZATION");
  assert.equal(approved.state, "READY_TO_DISPATCH");
});

test("requires strong approval for high-risk Slack commands", () => {
  const event = normalizeSlackEvent({
    event_id: "Ev-intake-deploy",
    ts: "1788946004.123456",
    channel: COCKPIT.channelId,
    user: COCKPIT.operatorUserId,
    text: "road run deploy service"
  });
  const weak = {
    inboundSubscriptionVerified: true,
    approval: {
      approved: true,
      canonicalEventId: event.canonicalEventId,
      contentHash: event.contentHash,
      threadTs: event.thread,
      strength: "NORMAL"
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
    buildReceipt({ providerAcknowledged: true, readBackVerified: false }).state,
    "WAITING_VERIFICATION"
  );
  assert.equal(
    buildReceipt({ providerAcknowledged: true, readBackVerified: true }).state,
    "COMPLETED"
  );
});

test("unknown timeouts require reconciliation and cannot auto-retry", () => {
  const receipt = buildReceipt({
    providerAcknowledged: false,
    readBackVerified: false,
    timeoutUnknown: true
  });

  assert.equal(receipt.state, "TIMEOUT_UNKNOWN");
  assert.equal(receipt.retryAllowed, false);
  assert.equal(receipt.reconcileRequired, true);
});
