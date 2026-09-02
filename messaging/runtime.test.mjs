import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalId,
  sha256,
  classifyOperation,
  platformCapability,
  validateOperationEnvelope,
  normalizeInboundEvent,
  LoopGuard,
  MemoryConversationStore,
  planCollaborationSequence,
  deliveryFromProviderResult,
  finishCollaborationSequence,
  hashProviderRequestShape,
  platforms,
  operations,
} from "./runtime.mjs";

const contentHash = sha256("hello");

function envelope(overrides = {}) {
  return {
    operation: "message.reply",
    platform: "slack",
    resourceKey: "slack://channel/private/thread/1",
    agentId: "agent-instance-4",
    sessionRef: "session-a",
    intentId: "intent-a",
    claimId: "claim-a",
    invocationId: "inv-a",
    idempotencyKey: "reply:1",
    requestHash: sha256("request"),
    targetOwnerAgent: "agent-instance-4",
    contentRef: "private://content/1",
    contentHash,
    userApprovalRef: "user-approval://current-request",
    ...overrides,
  };
}

test("registry has 18 platforms and 33 operations", () => {
  assert.equal(platforms.size, 18);
  assert.equal(operations.size, 33);
});

test("canonical IDs are stable and kind separated", () => {
  assert.equal(canonicalId("conversation", "same"), canonicalId("conversation", "same"));
  assert.notEqual(canonicalId("conversation", "same"), canonicalId("thread", "same"));
});

test("Slack reply is supported", () => {
  assert.equal(platformCapability("slack", "message.reply").supported, true);
});

test("Teams remains honestly configuration required", () => {
  assert.equal(platformCapability("microsoft-teams", "message.reply").reason, "CONFIG_REQUIRED");
});

test("unsupported provider operation is explicit", () => {
  assert.equal(platformCapability("asana", "reaction.add").reason, "UNSUPPORTED_OPERATION");
});

test("draft, communication, and administration are distinct", () => {
  assert.equal(classifyOperation("draft.create").actionClass, "WRITE");
  assert.equal(classifyOperation("message.post").actionClass, "COMMUNICATE");
  assert.equal(classifyOperation("channel.create").actionClass, "ADMIN");
});

test("communication requires explicit user approval", () => {
  assert.throws(
    () => validateOperationEnvelope(envelope({ userApprovalRef: null })),
    /user_approval_required/,
  );
});

test("administration requires governance receipt", () => {
  assert.throws(
    () => validateOperationEnvelope(envelope({ operation: "channel.create" })),
    /governance_receipt_required/,
  );
  assert.doesNotThrow(() =>
    validateOperationEnvelope(
      envelope({ operation: "channel.create", decisionReceiptRef: "neura://decision/1" }),
    ),
  );
});

test("an unsent draft needs a claim but not delivery approval", () => {
  assert.doesNotThrow(() =>
    validateOperationEnvelope(
      envelope({ operation: "draft.create", userApprovalRef: null }),
    ),
  );
});

test("control plane rejects raw message content", () => {
  assert.throws(
    () => validateOperationEnvelope({ ...envelope(), body: "do not store me" }),
    /content_or_secret_in_control_plane/,
  );
});

test("mutations require content reference and SHA-256", () => {
  assert.throws(
    () => validateOperationEnvelope(envelope({ contentHash: null })),
    /content_reference_and_hash_required/,
  );
});

test("normalized inbound event omits raw content", () => {
  const event = normalizeInboundEvent({
    platform: "slack",
    providerEventId: "evt-1",
    contentHash,
    messageRef: "m1",
  });
  assert.match(event.id, /^road:\/\/event\/[a-f0-9]{24}$/);
  assert.equal("body" in event, false);
});

test("bridge hop limit is enforced", () => {
  assert.throws(
    () =>
      normalizeInboundEvent({
        platform: "slack",
        providerEventId: "evt-hop",
        contentHash,
        hopCount: 5,
      }),
    /bridge_hop_limit/,
  );
});

test("loop guard rejects duplicate provider event", () => {
  const guard = new LoopGuard();
  const event = normalizeInboundEvent({
    platform: "slack",
    providerEventId: "evt-dup",
    contentHash,
  });
  assert.equal(guard.accept(event).accepted, true);
  assert.equal(guard.accept(event).reason, "duplicate_provider_event");
});

test("loop guard rejects own delivery echo", () => {
  const guard = new LoopGuard();
  guard.rememberOutbound("slack", "m-own");
  const event = normalizeInboundEvent({
    platform: "slack",
    providerEventId: "evt-own",
    messageRef: "m-own",
    contentHash,
  });
  assert.equal(guard.accept(event).reason, "own_echo");
});

test("one Road conversation binds Slack and Linear threads", () => {
  const store = new MemoryConversationStore();
  const conversation = store.createConversation({ title: "Gateway review", seed: "gateway-review" });
  store.bind(conversation.id, {
    platform: "slack",
    workspaceRef: "private://slack/workspace",
    channelRef: "private://slack/channel",
    threadRef: "private://slack/thread",
  });
  const updated = store.bind(conversation.id, {
    platform: "linear",
    workspaceRef: "private://linear/workspace",
    channelRef: "private://linear/issue",
    threadRef: "private://linear/comment-thread",
  });
  assert.equal(updated.bindings.length, 2);
  assert.equal(updated.id, conversation.id);
});

test("duplicate normalized event is idempotent", () => {
  const store = new MemoryConversationStore();
  const conversation = store.createConversation({ title: "One", seed: "one" });
  const event = normalizeInboundEvent({
    platform: "github",
    providerEventId: "comment-1",
    contentHash,
    type: "comment.created",
  });
  assert.equal(store.appendEvent(conversation.id, event).inserted, true);
  assert.equal(store.appendEvent(conversation.id, event).inserted, false);
});

test("provider acknowledgement enters VERIFYING", () => {
  const delivery = deliveryFromProviderResult({
    operation: "message.reply",
    platform: "slack",
    result: { ok: true, providerRequestRef: "req-1", providerMessageRef: "msg-1" },
  });
  assert.equal(delivery.state, "VERIFYING");
});

test("provider timeout remains TIMEOUT_UNKNOWN", () => {
  const delivery = deliveryFromProviderResult({
    operation: "comment.create",
    platform: "linear",
    result: { timeout: true, providerRequestRef: "req-unknown" },
  });
  assert.equal(delivery.state, "TIMEOUT_UNKNOWN");
});

test("provider request identity uses safe shape hash", () => {
  const hash = hashProviderRequestShape({
    toolName: "slack.reply",
    operation: "message.reply",
    platform: "slack",
    resourceKey: "r",
    contentHash,
    options: { broadcast: false },
  });
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
});

test("collaboration sequence binds exact runtime session", () => {
  const sequence = planCollaborationSequence(envelope());
  assert.deepEqual(
    sequence.map((entry) => entry.type),
    ["intent.create", "claim.acquire", "intent.executing", "invocation.start"],
  );
  assert.ok(sequence.every((entry) => entry.sessionRef === "session-a"));
});

test("successful provider result stops at verification required", () => {
  const delivery = deliveryFromProviderResult({
    operation: "message.reply",
    platform: "slack",
    result: { ok: true, providerRequestRef: "req-2", providerMessageRef: "msg-2" },
  });
  const sequence = finishCollaborationSequence(envelope(), delivery);
  assert.equal(sequence.at(-1).type, "verification.required");
  assert.equal(sequence.some((entry) => entry.type === "receipt.record"), false);
});

test("timeout produces unknown receipt and never fake success", () => {
  const delivery = deliveryFromProviderResult({
    operation: "message.reply",
    platform: "slack",
    result: { timeout: true, providerRequestRef: "req-3" },
  });
  const sequence = finishCollaborationSequence(envelope(), delivery);
  assert.equal(sequence.at(-1).result, "TIMEOUT_UNKNOWN");
});

test("read produces an observation, not an exclusive mutation sequence", () => {
  const sequence = planCollaborationSequence({
    operation: "thread.read",
    platform: "slack",
    resourceKey: "slack://thread/1",
    agentId: "agent-instance-2",
    contentHash,
  });
  assert.deepEqual(sequence.map((entry) => entry.type), ["observation.record"]);
});
