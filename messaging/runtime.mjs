import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const contracts = JSON.parse(readFileSync(new URL("contracts.json", import.meta.url), "utf8"));

export const platforms = new Map(contracts.platforms.map((item) => [item.id, item]));
export const operations = new Map(
  contracts.operations.map(([id, actionClass, externalEffect, verification]) => [
    id,
    { id, actionClass, externalEffect, verification },
  ]),
);
export const policy = Object.freeze(contracts.policy);

export function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export function canonicalId(kind, seed) {
  const digest = createHash("sha256")
    .update(`${kind}\0${seed}`)
    .digest("hex")
    .slice(0, 24);
  return `road://${kind}/${digest}`;
}

export function classifyOperation(operationId) {
  const operation = operations.get(operationId);
  if (!operation) throw new Error(`unsupported_operation:${operationId}`);
  return operation;
}

export function platformCapability(platformId, operationId) {
  const platform = platforms.get(platformId);
  if (!platform) return { supported: false, reason: "unknown_platform" };
  if (platform.state.includes("CONFIG_REQUIRED")) {
    return { supported: false, reason: "CONFIG_REQUIRED", platform };
  }
  if (platform.capabilities !== "*" && !platform.capabilities.includes(operationId)) {
    return { supported: false, reason: "UNSUPPORTED_OPERATION", platform };
  }
  return { supported: true, platform };
}

const forbiddenControlKeys = new Set([
  "text",
  "body",
  "markdown",
  "html",
  "token",
  "secret",
  "password",
  "authorization",
  "apiKey",
  "api_key",
  "cookie",
  "accessToken",
  "refreshToken",
]);

function findForbiddenKey(value, path = []) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenControlKeys.has(key)) return [...path, key].join(".");
    const nested = findForbiddenKey(child, [...path, key]);
    if (nested) return nested;
  }
  return null;
}

export function validateOperationEnvelope(envelope) {
  const operation = classifyOperation(envelope.operation);
  const capability = platformCapability(envelope.platform, envelope.operation);
  if (!capability.supported) {
    throw new Error(`${capability.reason}:${envelope.platform}:${envelope.operation}`);
  }
  if (!/^(connector-orchestrator|agent-instance-[1-6])$/.test(envelope.agentId ?? "")) {
    throw new Error("invalid_agent");
  }
  if (!envelope.resourceKey) throw new Error("resource_key_required");

  const forbidden = findForbiddenKey(envelope);
  if (forbidden) throw new Error(`content_or_secret_in_control_plane:${forbidden}`);

  const mutating = operation.actionClass !== "READ";
  if (mutating) {
    for (const field of [
      "sessionRef",
      "intentId",
      "claimId",
      "invocationId",
      "idempotencyKey",
      "requestHash",
      "targetOwnerAgent",
    ]) {
      if (!envelope[field]) throw new Error(`${field}_required`);
    }
    if (!envelope.contentRef || !/^sha256:[a-f0-9]{64}$/.test(envelope.contentHash ?? "")) {
      throw new Error("content_reference_and_hash_required");
    }
  }

  if (["COMMUNICATE", "ADMIN"].includes(operation.actionClass) && !envelope.userApprovalRef) {
    throw new Error("user_approval_required");
  }
  if (operation.actionClass === "ADMIN" && !envelope.decisionReceiptRef) {
    throw new Error("governance_receipt_required");
  }

  return { operation, platform: capability.platform, mutating };
}

export function normalizeInboundEvent(input) {
  if (!input.platform || !input.providerEventId) {
    throw new Error("platform_and_provider_event_required");
  }
  if (!platforms.has(input.platform)) throw new Error(`unknown_platform:${input.platform}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.contentHash ?? "")) {
    throw new Error("content_hash_required");
  }

  const hopCount = Number(input.hopCount ?? 0);
  if (!Number.isInteger(hopCount) || hopCount < 0 || hopCount > policy.maxBridgeHops) {
    throw new Error("bridge_hop_limit");
  }

  return Object.freeze({
    id: canonicalId("event", `${input.platform}:${input.providerEventId}`),
    type: input.type ?? "message.received",
    platform: input.platform,
    providerEventId: String(input.providerEventId),
    conversationId: input.conversationId ?? null,
    threadRef: input.threadRef ?? null,
    messageRef: input.messageRef ?? null,
    authorRef: input.authorRef ?? null,
    contentRef: input.contentRef ?? null,
    contentHash: input.contentHash,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    hopCount,
    routeTrace: Array.isArray(input.routeTrace) ? [...input.routeTrace] : [],
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

export class LoopGuard {
  constructor({ maxHops = policy.maxBridgeHops } = {}) {
    this.maxHops = maxHops;
    this.providerEvents = new Set();
    this.outboundMessageRefs = new Set();
  }

  rememberOutbound(platform, messageRef) {
    this.outboundMessageRefs.add(`${platform}:${messageRef}`);
  }

  accept(event) {
    const eventKey = `${event.platform}:${event.providerEventId}`;
    if (this.providerEvents.has(eventKey)) {
      return { accepted: false, reason: "duplicate_provider_event" };
    }
    if (event.messageRef && this.outboundMessageRefs.has(`${event.platform}:${event.messageRef}`)) {
      return { accepted: false, reason: "own_echo" };
    }
    if (event.hopCount >= this.maxHops) {
      return { accepted: false, reason: "bridge_hop_limit" };
    }
    if (new Set(event.routeTrace).size !== event.routeTrace.length) {
      return { accepted: false, reason: "route_loop" };
    }
    this.providerEvents.add(eventKey);
    return { accepted: true };
  }
}

export class MemoryConversationStore {
  constructor() {
    this.conversations = new Map();
    this.events = new Map();
  }

  createConversation({ title, seed = randomUUID(), labels = [] }) {
    const now = new Date().toISOString();
    const conversation = {
      id: canonicalId("conversation", seed),
      title,
      state: "OPEN",
      createdAt: now,
      updatedAt: now,
      bindings: [],
      labels: [...new Set(labels)],
    };
    this.conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  bind(conversationId, binding) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation_not_found");
    const key = `${binding.platform}:${binding.workspaceRef}:${binding.channelRef}:${binding.threadRef}`;
    const exists = conversation.bindings.some(
      (item) => `${item.platform}:${item.workspaceRef}:${item.channelRef}:${item.threadRef}` === key,
    );
    if (!exists) {
      conversation.bindings.push({
        visibility: "INTERNAL",
        messageRef: null,
        versionRef: null,
        state: "BOUND",
        ...binding,
      });
      conversation.updatedAt = new Date().toISOString();
    }
    return structuredClone(conversation);
  }

  appendEvent(conversationId, event) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation_not_found");
    if (this.events.has(event.id)) {
      return { inserted: false, event: structuredClone(this.events.get(event.id)) };
    }
    const stored = { ...event, conversationId };
    this.events.set(event.id, stored);
    conversation.updatedAt = new Date().toISOString();
    return { inserted: true, event: structuredClone(stored) };
  }
}

export function planCollaborationSequence(envelope) {
  const { operation } = validateOperationEnvelope(envelope);
  const base = {
    agentId: envelope.agentId,
    sessionRef: envelope.sessionRef ?? null,
    connectorId: envelope.platform,
    resourceKey: envelope.resourceKey,
    actionClass: operation.actionClass,
    targetOwnerAgent: envelope.targetOwnerAgent ?? null,
  };
  if (operation.actionClass === "READ") {
    return [{ type: "observation.record", ...base, contentHash: envelope.contentHash ?? null }];
  }
  return [
    {
      type: "intent.create",
      ...base,
      intentId: envelope.intentId,
      idempotencyKey: envelope.idempotencyKey,
      userApprovalRef: envelope.userApprovalRef ?? null,
      decisionReceiptRef: envelope.decisionReceiptRef ?? null,
    },
    { type: "claim.acquire", ...base, intentId: envelope.intentId, claimId: envelope.claimId },
    { type: "intent.executing", ...base, intentId: envelope.intentId },
    {
      type: "invocation.start",
      ...base,
      intentId: envelope.intentId,
      invocationId: envelope.invocationId,
      requestHash: envelope.requestHash,
    },
  ];
}

export function hashProviderRequestShape({
  toolName,
  operation,
  platform,
  resourceKey,
  contentHash,
  options = {},
}) {
  return sha256(JSON.stringify({ toolName, operation, platform, resourceKey, contentHash, options }));
}

export function deliveryFromProviderResult({ operation, platform, result, now = new Date().toISOString() }) {
  const delivery = {
    id: canonicalId(
      "delivery",
      `${platform}:${operation}:${result.providerRequestRef ?? randomUUID()}`,
    ),
    operation,
    platform,
    providerRequestRef: result.providerRequestRef ?? null,
    providerMessageRef: result.providerMessageRef ?? null,
    verificationRef: null,
    createdAt: now,
    updatedAt: now,
  };
  if (result.timeout === true || result.state === "TIMEOUT_UNKNOWN") {
    return { ...delivery, state: "TIMEOUT_UNKNOWN" };
  }
  if (result.ok === false) return { ...delivery, state: "FAILED" };
  const operationSpec = classifyOperation(operation);
  return {
    ...delivery,
    state: operationSpec.externalEffect ? "VERIFYING" : "PROVIDER_ACKNOWLEDGED",
  };
}

export function finishCollaborationSequence(envelope, delivery) {
  const { operation } = validateOperationEnvelope(envelope);
  if (operation.actionClass === "READ") return [];
  const base = {
    agentId: envelope.agentId,
    sessionRef: envelope.sessionRef,
    connectorId: envelope.platform,
    resourceKey: envelope.resourceKey,
    intentId: envelope.intentId,
    invocationId: envelope.invocationId,
    claimId: envelope.claimId,
  };
  if (delivery.state === "TIMEOUT_UNKNOWN") {
    return [
      {
        type: "invocation.finish",
        ...base,
        outcome: "TIMEOUT_UNKNOWN",
        providerRequestRef: delivery.providerRequestRef,
      },
      { type: "receipt.record", ...base, result: "TIMEOUT_UNKNOWN" },
    ];
  }
  if (delivery.state === "FAILED") {
    return [
      {
        type: "invocation.finish",
        ...base,
        outcome: "FAILED",
        providerRequestRef: delivery.providerRequestRef,
      },
      { type: "receipt.record", ...base, result: "FAILED" },
      { type: "claim.release", ...base },
    ];
  }
  return [
    {
      type: "invocation.finish",
      ...base,
      outcome: delivery.state,
      providerRequestRef: delivery.providerRequestRef,
      providerMessageRef: delivery.providerMessageRef,
    },
    {
      type: "verification.required",
      ...base,
      verificationKind: operation.verification,
      providerMessageRef: delivery.providerMessageRef,
    },
  ];
}
