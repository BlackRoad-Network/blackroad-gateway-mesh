import test from "node:test";
import assert from "node:assert/strict";

import {
  COCKPIT,
  buildReceipt,
  normalizeGitHubPullRequestEvent,
  normalizeSlackEvent,
  parseRoadCommand,
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
