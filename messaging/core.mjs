import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = '1.0';
export const SERVICE_URI = 'road://service/messaging';
export const MESSAGE_KINDS = new Set(['COMMENT','QUESTION','ANSWER','DECISION','STATUS','BLOCKER','HANDOFF','REVIEW','SYSTEM']);
export const THREAD_STATES = new Set(['OPEN','RESOLVED','ARCHIVED']);
export const DELIVERY_STATES = new Set(['PLANNED','SENDING','PROVIDER_ACKNOWLEDGED','VERIFYING','DELIVERED','PARTIAL','FAILED','TIMEOUT_UNKNOWN','CANCELLED']);
const MUTATING_DELIVERY_ACTIONS = new Set(['POST','REPLY','EDIT','DELETE','REACT','RESOLVE','BRIDGE']);
const ACTIVE_DELIVERY_STATES = new Set(['PLANNED','SENDING','PROVIDER_ACKNOWLEDGED','VERIFYING','TIMEOUT_UNKNOWN']);

export const PROVIDERS = Object.freeze({
  slack: { status: 'CONNECTED', capabilities: ['spaces.search','messages.read','threads.read','messages.send','messages.reply','messages.edit','messages.delete','messages.schedule','drafts.create','canvases.read','canvases.create','canvases.update'], verify: 'read-message-or-thread-after-write' },
  'microsoft-teams': { status: 'CONNECTOR_UNAVAILABLE', capabilities: ['teams.list','channels.list','messages.read','messages.send','messages.reply','messages.edit','messages.delete','reactions.add'], verify: 'read-message-or-reply-after-write' },
  github: { status: 'CONNECTED', capabilities: ['issues.read','issues.comment','pulls.read','pulls.comment','reviews.comment','threads.resolve'], verify: 'read-comment-or-thread-after-write' },
  linear: { status: 'CONNECTED', capabilities: ['issues.read','comments.read','comments.create','comments.update'], verify: 'read-comment-after-write' },
  notion: { status: 'CONNECTED', capabilities: ['pages.read','comments.read','comments.create'], verify: 'read-comment-after-write' },
  gmail: { status: 'CONNECTED', capabilities: ['threads.read','drafts.create','messages.send','messages.reply'], verify: 'read-sent-message-or-thread-after-write' },
  resend: { status: 'READY_EMPTY', capabilities: ['messages.send','delivery.status','webhooks.receive'], verify: 'provider-delivery-status' },
});

const SECRET_PATTERNS = [
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{8,}/i,
];

export class MessagingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.details = details;
  }
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function safeText(value, field = 'text') {
  if (value === undefined || value === null) return;
  const text = String(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new MessagingError('SECRET_MATERIAL_REJECTED', `${field} appears to contain secret material; use a reference instead`);
  }
}

export function redactInbound(value) {
  const text = String(value ?? '');
  return SECRET_PATTERNS.some((pattern) => pattern.test(text)) ? '[REDACTED_SECRET_PATTERN]' : text;
}

function nowIso(options = {}) {
  return new Date(options.now ?? Date.now()).toISOString();
}

function makeId(prefix, options = {}) {
  const raw = options.idFactory ? options.idFactory(prefix) : randomUUID();
  return `${prefix}_${raw}`;
}

function clone(state) {
  return structuredClone(state ?? createEmptyState());
}

export function createEmptyState() {
  return {
    schema: 'road-messaging-state-v1',
    protocolVersion: PROTOCOL_VERSION,
    revision: 0,
    spaces: [],
    threads: [],
    messages: [],
    reactions: [],
    readMarkers: [],
    deliveries: [],
    inboundEvents: [],
    events: [],
    eventHead: null,
  };
}

function emit(state, type, actorId, payload = {}, options = {}) {
  const timestamp = nowIso(options);
  const base = {
    id: makeId('event', options),
    type,
    actorId,
    timestamp,
    previousHash: state.eventHead,
    payload,
  };
  safeText(actorId, 'event.actorId');
  safeText(canonical(payload), 'event.payload');
  const hash = sha256(canonical(base));
  const event = { ...base, hash };
  state.events.push(event);
  state.eventHead = hash;
  state.revision += 1;
  return event;
}

function requireSpace(state, spaceId) {
  const value = state.spaces.find((item) => item.id === spaceId);
  if (!value) throw new MessagingError('SPACE_NOT_FOUND', `Space ${spaceId} does not exist`);
  return value;
}

function requireThread(state, threadId) {
  const value = state.threads.find((item) => item.id === threadId);
  if (!value) throw new MessagingError('THREAD_NOT_FOUND', `Thread ${threadId} does not exist`);
  return value;
}

function requireMessage(state, messageId) {
  const value = state.messages.find((item) => item.id === messageId);
  if (!value) throw new MessagingError('MESSAGE_NOT_FOUND', `Message ${messageId} does not exist`);
  return value;
}

function requireDelivery(state, deliveryId) {
  const value = state.deliveries.find((item) => item.id === deliveryId);
  if (!value) throw new MessagingError('DELIVERY_NOT_FOUND', `Delivery ${deliveryId} does not exist`);
  return value;
}

function requireActiveSession(input) {
  if (!input.sessionRef) throw new MessagingError('SESSION_REQUIRED', 'A live runtime session reference is required');
  if (input.sessionState && input.sessionState !== 'ONLINE') throw new MessagingError('SESSION_NOT_ACTIVE', `Session ${input.sessionRef} is not online`);
}

export function createSpace(state, input, options = {}) {
  safeText(input.name, 'space.name');
  safeText(input.actorId, 'space.actorId');
  if (!input.name || !input.actorId) throw new MessagingError('INVALID_SPACE', 'name and actorId are required');
  const next = clone(state);
  const slug = String(input.slug ?? input.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new MessagingError('INVALID_SPACE_SLUG', 'Space slug is empty after normalization');
  if (next.spaces.some((item) => item.slug === slug)) throw new MessagingError('SPACE_EXISTS', `Space ${slug} already exists`);
  const createdAt = nowIso(options);
  const space = {
    id: makeId('space', options),
    roadUri: `road://space/${slug}`,
    slug,
    name: input.name,
    visibility: input.visibility ?? 'INTERNAL',
    ownerId: input.ownerId ?? input.actorId,
    members: [...new Set([input.actorId, ...(input.members ?? [])])],
    providerBindings: input.providerBindings ?? [],
    metadata: input.metadata ?? {},
    createdAt,
    updatedAt: createdAt,
  };
  next.spaces.push(space);
  emit(next, 'road.messaging.space.created', input.actorId, { spaceId: space.id, roadUri: space.roadUri }, options);
  return { state: next, space };
}

export function createThread(state, input, options = {}) {
  safeText(input.title, 'thread.title');
  safeText(input.actorId, 'thread.actorId');
  if (!input.spaceId || !input.title || !input.actorId) throw new MessagingError('INVALID_THREAD', 'spaceId, title, and actorId are required');
  const next = clone(state);
  requireSpace(next, input.spaceId);
  const slug = String(input.slug ?? input.title).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const createdAt = nowIso(options);
  const thread = {
    id: makeId('thread', options),
    roadUri: `road://thread/${slug || makeId('thread-name', options)}`,
    spaceId: input.spaceId,
    title: input.title,
    state: 'OPEN',
    createdAt,
    updatedAt: createdAt,
    createdBy: input.actorId,
    resolvedAt: null,
    resolvedBy: null,
    tags: [...new Set(input.tags ?? [])],
    resourceRefs: [...new Set(input.resourceRefs ?? [])],
    providerBindings: input.providerBindings ?? [],
  };
  next.threads.push(thread);
  emit(next, 'road.messaging.thread.created', input.actorId, { threadId: thread.id, spaceId: thread.spaceId }, options);
  return { state: next, thread };
}

export function postMessage(state, input, options = {}) {
  safeText(input.body, 'message.body');
  safeText(input.authorId, 'message.authorId');
  if (!input.threadId || !input.authorId || !input.body) throw new MessagingError('INVALID_MESSAGE', 'threadId, authorId, and body are required');
  const kind = input.kind ?? 'COMMENT';
  if (!MESSAGE_KINDS.has(kind)) throw new MessagingError('INVALID_MESSAGE_KIND', `Unsupported message kind ${kind}`);
  if (String(input.body).length > 50000) throw new MessagingError('MESSAGE_TOO_LARGE', 'Message body exceeds 50,000 characters');
  const next = clone(state);
  const thread = requireThread(next, input.threadId);
  if (thread.state !== 'OPEN' && !['SYSTEM','DECISION'].includes(kind)) throw new MessagingError('THREAD_NOT_OPEN', `Thread ${thread.id} is ${thread.state}`);
  if (input.parentMessageId) {
    const parent = requireMessage(next, input.parentMessageId);
    if (parent.threadId !== thread.id) throw new MessagingError('PARENT_THREAD_MISMATCH', 'Reply parent belongs to another thread');
  }
  const contentHash = sha256(input.body);
  if (input.idempotencyKey) {
    const existing = next.messages.find((message) => message.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.threadId !== input.threadId || existing.authorId !== input.authorId || existing.contentHash !== contentHash || existing.kind !== kind) {
        throw new MessagingError('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different message semantics');
      }
      return { state: next, message: existing, replay: true };
    }
  }
  const createdAt = nowIso(options);
  const message = {
    id: makeId('msg', options),
    roadUri: `road://message/${makeId('message-uri', options)}`,
    threadId: input.threadId,
    parentMessageId: input.parentMessageId ?? null,
    authorId: input.authorId,
    kind,
    body: String(input.body),
    contentHash,
    state: input.state ?? 'POSTED',
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    metadata: input.metadata ?? {},
    mentions: [...new Set(input.mentions ?? [])],
    attachmentRefs: [...new Set(input.attachmentRefs ?? [])],
    originMessageId: input.originMessageId ?? null,
    bridgeTrace: [...new Set(input.bridgeTrace ?? [])],
    hopCount: input.hopCount ?? 0,
    providerBindings: input.providerBindings ?? [],
    revisions: [],
    collaborationRefs: input.collaborationRefs ?? {},
    idempotencyKey: input.idempotencyKey ?? null,
  };
  if (message.hopCount > 4) throw new MessagingError('BRIDGE_HOP_LIMIT', 'Bridge hop limit exceeded');
  next.messages.push(message);
  thread.updatedAt = createdAt;
  emit(next, 'road.messaging.message.posted', input.authorId, { messageId: message.id, threadId: thread.id, kind }, options);
  return { state: next, message, replay: false };
}

export function editMessage(state, input, options = {}) {
  safeText(input.body, 'message.body');
  const next = clone(state);
  const message = requireMessage(next, input.messageId);
  if (message.authorId !== input.actorId && !input.moderator) throw new MessagingError('EDIT_FORBIDDEN', 'Only the author or an authorized moderator may edit this message');
  if (message.state === 'TOMBSTONED') throw new MessagingError('MESSAGE_TOMBSTONED', 'A tombstoned message cannot be edited');
  const timestamp = nowIso(options);
  message.revisions.push({ body: message.body, contentHash: message.contentHash, state: message.state, replacedAt: timestamp, replacedBy: input.actorId });
  message.body = String(input.body);
  message.contentHash = sha256(message.body);
  message.state = 'EDITED';
  message.editedAt = timestamp;
  message.updatedAt = timestamp;
  emit(next, 'road.messaging.message.edited', input.actorId, { messageId: message.id, revisionCount: message.revisions.length }, options);
  return { state: next, message };
}

export function tombstoneMessage(state, input, options = {}) {
  const next = clone(state);
  const message = requireMessage(next, input.messageId);
  if (message.authorId !== input.actorId && !input.moderator) throw new MessagingError('DELETE_FORBIDDEN', 'Only the author or an authorized moderator may tombstone this message');
  const timestamp = nowIso(options);
  message.revisions.push({ body: message.body, contentHash: message.contentHash, state: message.state, replacedAt: timestamp, replacedBy: input.actorId });
  message.body = '[TOMBSTONED]';
  message.contentHash = sha256(message.body);
  message.state = 'TOMBSTONED';
  message.updatedAt = timestamp;
  emit(next, 'road.messaging.message.tombstoned', input.actorId, { messageId: message.id }, options);
  return { state: next, message };
}

export function addReaction(state, input, options = {}) {
  safeText(input.emoji, 'reaction.emoji');
  const next = clone(state);
  requireMessage(next, input.messageId);
  const existing = next.reactions.find((item) => item.messageId === input.messageId && item.principalId === input.principalId && item.emoji === input.emoji);
  if (existing) return { state: next, reaction: existing, replay: true };
  const reaction = { id: makeId('reaction', options), messageId: input.messageId, principalId: input.principalId, emoji: input.emoji, createdAt: nowIso(options) };
  next.reactions.push(reaction);
  emit(next, 'road.messaging.reaction.added', input.principalId, { reactionId: reaction.id, messageId: input.messageId, emoji: input.emoji }, options);
  return { state: next, reaction, replay: false };
}

export function markRead(state, input, options = {}) {
  const next = clone(state);
  requireThread(next, input.threadId);
  const timestamp = nowIso(options);
  const marker = next.readMarkers.find((item) => item.threadId === input.threadId && item.principalId === input.principalId);
  const lastMessageId = input.lastMessageId ?? next.messages.filter((item) => item.threadId === input.threadId).at(-1)?.id ?? null;
  if (marker) {
    marker.lastMessageId = lastMessageId;
    marker.updatedAt = timestamp;
  } else {
    next.readMarkers.push({ id: makeId('read', options), threadId: input.threadId, principalId: input.principalId, lastMessageId, updatedAt: timestamp });
  }
  emit(next, 'road.messaging.thread.read', input.principalId, { threadId: input.threadId, lastMessageId }, options);
  return { state: next, marker: next.readMarkers.find((item) => item.threadId === input.threadId && item.principalId === input.principalId) };
}

export function unreadCount(state, threadId, principalId) {
  requireThread(state, threadId);
  const messages = state.messages.filter((item) => item.threadId === threadId && item.state !== 'TOMBSTONED');
  const marker = state.readMarkers.find((item) => item.threadId === threadId && item.principalId === principalId);
  if (!marker?.lastMessageId) return messages.filter((item) => item.authorId !== principalId).length;
  const index = messages.findIndex((item) => item.id === marker.lastMessageId);
  return messages.slice(index + 1).filter((item) => item.authorId !== principalId).length;
}

export function setThreadState(state, input, options = {}) {
  if (!THREAD_STATES.has(input.state)) throw new MessagingError('INVALID_THREAD_STATE', `Unsupported thread state ${input.state}`);
  const next = clone(state);
  const thread = requireThread(next, input.threadId);
  thread.state = input.state;
  thread.updatedAt = nowIso(options);
  thread.resolvedAt = input.state === 'RESOLVED' ? thread.updatedAt : null;
  thread.resolvedBy = input.state === 'RESOLVED' ? input.actorId : null;
  emit(next, 'road.messaging.thread.state-changed', input.actorId, { threadId: thread.id, state: thread.state }, options);
  return { state: next, thread };
}

export function threadView(state, threadId, principalId = null) {
  const thread = requireThread(state, threadId);
  const messages = state.messages.filter((item) => item.threadId === threadId);
  return {
    thread: structuredClone(thread),
    messages: structuredClone(messages),
    reactions: structuredClone(state.reactions.filter((item) => messages.some((message) => message.id === item.messageId))),
    unread: principalId ? unreadCount(state, threadId, principalId) : null,
  };
}

export function ingestProviderMessage(state, input, options = {}) {
  safeText(input.providerEventId, 'providerEventId');
  if (!input.provider || !input.providerEventId || !input.threadId) throw new MessagingError('INVALID_PROVIDER_EVENT', 'provider, providerEventId, and threadId are required');
  const next = clone(state);
  const dedupeKey = `${input.provider}:${input.providerEventId}`;
  const existing = next.inboundEvents.find((item) => item.dedupeKey === dedupeKey);
  if (existing) return { state: next, inboundEvent: existing, replay: true };
  const bridgeTrace = [...new Set(input.bridgeTrace ?? [input.provider])];
  if (bridgeTrace.length > 4) throw new MessagingError('BRIDGE_HOP_LIMIT', 'Bridge hop limit exceeded');
  const posted = postMessage(next, {
    threadId: input.threadId,
    authorId: input.authorId,
    body: redactInbound(input.body),
    kind: input.kind ?? 'COMMENT',
    idempotencyKey: `inbound:${dedupeKey}`,
    originMessageId: input.originMessageId ?? null,
    bridgeTrace,
    hopCount: bridgeTrace.length,
    providerBindings: [{ provider: input.provider, resourceKey: input.resourceKey, messageRef: input.providerMessageRef ?? null }],
  }, options);
  const inboundEvent = { id: makeId('inbound', options), dedupeKey, provider: input.provider, providerEventId: input.providerEventId, messageId: posted.message.id, receivedAt: nowIso(options) };
  posted.state.inboundEvents.push(inboundEvent);
  emit(posted.state, 'road.messaging.provider.inbound', input.authorId, { provider: input.provider, providerEventId: input.providerEventId, messageId: posted.message.id }, options);
  return { state: posted.state, inboundEvent, message: posted.message, replay: false };
}

export function operationPlan(input) {
  const provider = PROVIDERS[input.provider];
  const blockers = [];
  if (!provider) blockers.push('UNKNOWN_PROVIDER');
  if (provider?.status === 'CONNECTOR_UNAVAILABLE') blockers.push('CONNECTOR_UNAVAILABLE');
  if (provider?.status === 'READY_EMPTY') blockers.push('PROVIDER_NOT_READY_FOR_OUTBOUND');
  if (MUTATING_DELIVERY_ACTIONS.has(input.action ?? 'POST')) {
    if (!input.sessionRef) blockers.push('SESSION_REQUIRED');
    if (!input.actorId) blockers.push('ACTOR_REQUIRED');
    if (!input.targetOwnerAgent) blockers.push('TARGET_OWNER_REQUIRED');
    if (!input.idempotencyKey) blockers.push('IDEMPOTENCY_KEY_REQUIRED');
    if (!input.collaborationIntentRef) blockers.push('COLLABORATION_INTENT_REQUIRED');
    if (!input.collaborationClaimRef) blockers.push('COLLABORATION_CLAIM_REQUIRED');
    if (!input.userApprovalRef) blockers.push('USER_APPROVAL_REQUIRED');
  }
  return {
    schema: 'road-messaging-operation-plan-v1',
    provider: input.provider,
    action: input.action ?? 'POST',
    resourceKey: input.resourceKey ?? null,
    providerStatus: provider?.status ?? 'UNKNOWN',
    requiredVerification: provider?.verify ?? null,
    blockers,
    ready: blockers.length === 0,
    executesProviderCall: false,
  };
}

export function planDelivery(state, input, options = {}) {
  const next = clone(state);
  requireMessage(next, input.messageId);
  requireActiveSession(input);
  safeText(input.resourceKey, 'delivery.resourceKey');
  const plan = operationPlan(input);
  if (!plan.ready) throw new MessagingError('DELIVERY_BLOCKED', 'Delivery prerequisites are incomplete', { blockers: plan.blockers });
  const requestHash = sha256(canonical({ provider: input.provider, action: input.action, resourceKey: input.resourceKey, messageId: input.messageId, targetVersionRef: input.targetVersionRef ?? null }));
  const existing = next.deliveries.find((item) => item.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.sessionRef !== input.sessionRef) throw new MessagingError('IDEMPOTENCY_CONFLICT', 'Delivery idempotency key was reused with changed semantics or session');
    return { state: next, delivery: existing, replay: true };
  }
  const createdAt = nowIso(options);
  const delivery = {
    id: makeId('delivery', options),
    messageId: input.messageId,
    provider: input.provider,
    resourceKey: input.resourceKey,
    action: input.action,
    state: 'PLANNED',
    idempotencyKey: input.idempotencyKey,
    requestHash,
    collaborationIntentRef: input.collaborationIntentRef,
    collaborationClaimRef: input.collaborationClaimRef,
    userApprovalRef: input.userApprovalRef,
    targetOwnerAgent: input.targetOwnerAgent,
    targetVersionRef: input.targetVersionRef ?? null,
    sessionRef: input.sessionRef,
    actorId: input.actorId,
    invocationRef: null,
    providerRequestRef: null,
    providerMessageRef: null,
    verificationRef: null,
    evidenceRefs: [],
    adapterStatus: PROVIDERS[input.provider].status,
    retryable: false,
    errorCode: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  next.deliveries.push(delivery);
  emit(next, 'road.messaging.delivery.planned', input.actorId, { deliveryId: delivery.id, provider: delivery.provider, resourceKey: delivery.resourceKey }, options);
  return { state: next, delivery, replay: false };
}

function assertDeliverySession(delivery, input) {
  requireActiveSession(input);
  if (delivery.sessionRef !== input.sessionRef || delivery.actorId !== input.actorId) {
    throw new MessagingError('DELIVERY_SESSION_MISMATCH', 'The exact runtime session and actor that owns the delivery must continue it');
  }
}

export function startDelivery(state, input, options = {}) {
  const next = clone(state);
  const delivery = requireDelivery(next, input.deliveryId);
  assertDeliverySession(delivery, input);
  if (delivery.state !== 'PLANNED') throw new MessagingError('INVALID_DELIVERY_STATE', `Cannot start delivery from ${delivery.state}`);
  delivery.state = 'SENDING';
  delivery.invocationRef = input.invocationRef;
  delivery.updatedAt = nowIso(options);
  emit(next, 'road.messaging.delivery.started', input.actorId, { deliveryId: delivery.id, invocationRef: delivery.invocationRef }, options);
  return { state: next, delivery };
}

export function recordProviderOutcome(state, input, options = {}) {
  const next = clone(state);
  const delivery = requireDelivery(next, input.deliveryId);
  assertDeliverySession(delivery, input);
  if (delivery.state !== 'SENDING') throw new MessagingError('INVALID_DELIVERY_STATE', `Cannot record provider result from ${delivery.state}`);
  const outcome = input.outcome;
  const timestamp = nowIso(options);
  delivery.providerRequestRef = input.providerRequestRef ?? null;
  delivery.providerMessageRef = input.providerMessageRef ?? null;
  delivery.evidenceRefs = [...new Set([...(delivery.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])])];
  if (outcome === 'SUCCESS') {
    delivery.state = 'PROVIDER_ACKNOWLEDGED';
    delivery.retryable = false;
  } else if (outcome === 'TIMEOUT') {
    delivery.state = 'TIMEOUT_UNKNOWN';
    delivery.retryable = false;
    delivery.errorCode = 'TIMEOUT_UNKNOWN';
  } else if (outcome === 'PARTIAL') {
    delivery.state = 'PARTIAL';
    delivery.retryable = Boolean(input.retryable);
    delivery.errorCode = input.errorCode ?? 'PARTIAL';
  } else {
    delivery.state = 'FAILED';
    delivery.retryable = Boolean(input.retryable);
    delivery.errorCode = input.errorCode ?? 'PROVIDER_FAILED';
    delivery.completedAt = timestamp;
  }
  delivery.updatedAt = timestamp;
  emit(next, 'road.messaging.delivery.provider-outcome', input.actorId, { deliveryId: delivery.id, outcome, state: delivery.state }, options);
  return { state: next, delivery };
}

export function beginVerification(state, input, options = {}) {
  const next = clone(state);
  const delivery = requireDelivery(next, input.deliveryId);
  assertDeliverySession(delivery, input);
  if (!['PROVIDER_ACKNOWLEDGED','TIMEOUT_UNKNOWN'].includes(delivery.state)) throw new MessagingError('INVALID_DELIVERY_STATE', `Cannot verify delivery from ${delivery.state}`);
  delivery.state = 'VERIFYING';
  delivery.updatedAt = nowIso(options);
  emit(next, 'road.messaging.delivery.verifying', input.actorId, { deliveryId: delivery.id }, options);
  return { state: next, delivery };
}

export function verifyDelivery(state, input, options = {}) {
  const next = clone(state);
  const delivery = requireDelivery(next, input.deliveryId);
  assertDeliverySession(delivery, input);
  if (delivery.state !== 'VERIFYING') throw new MessagingError('INVALID_DELIVERY_STATE', `Cannot finish verification from ${delivery.state}`);
  const timestamp = nowIso(options);
  delivery.verificationRef = input.verificationRef;
  delivery.evidenceRefs = [...new Set([...(delivery.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])])];
  if (input.verified) {
    delivery.state = 'DELIVERED';
    delivery.completedAt = timestamp;
    delivery.errorCode = null;
  } else {
    delivery.state = input.unknown ? 'TIMEOUT_UNKNOWN' : 'FAILED';
    delivery.errorCode = input.unknown ? 'TIMEOUT_UNKNOWN' : 'VERIFICATION_FAILED';
    delivery.completedAt = input.unknown ? null : timestamp;
  }
  delivery.updatedAt = timestamp;
  emit(next, 'road.messaging.delivery.verified', input.actorId, { deliveryId: delivery.id, verified: Boolean(input.verified), state: delivery.state }, options);
  return { state: next, delivery };
}

export function reconcileTimeout(state, input, options = {}) {
  const next = clone(state);
  const delivery = requireDelivery(next, input.deliveryId);
  assertDeliverySession(delivery, input);
  if (delivery.state !== 'TIMEOUT_UNKNOWN') throw new MessagingError('INVALID_DELIVERY_STATE', 'Only TIMEOUT_UNKNOWN deliveries may be reconciled');
  if (input.result === 'APPLIED') {
    delivery.state = 'DELIVERED';
    delivery.verificationRef = input.verificationRef;
    delivery.completedAt = nowIso(options);
    delivery.errorCode = null;
  } else if (input.result === 'NOT_APPLIED') {
    delivery.state = 'FAILED';
    delivery.completedAt = nowIso(options);
    delivery.errorCode = 'NOT_APPLIED';
    delivery.retryable = true;
  } else if (input.result !== 'STILL_UNKNOWN') {
    throw new MessagingError('INVALID_RECONCILIATION', `Unsupported timeout reconciliation ${input.result}`);
  }
  delivery.updatedAt = nowIso(options);
  emit(next, 'road.messaging.delivery.reconciled', input.actorId, { deliveryId: delivery.id, result: input.result, state: delivery.state }, options);
  return { state: next, delivery };
}

export function planBridge(input) {
  const trace = [...new Set(input.bridgeTrace ?? [])];
  if (trace.includes(input.targetProvider)) throw new MessagingError('BRIDGE_LOOP', `Provider ${input.targetProvider} already appears in the bridge trace`);
  if (trace.length >= 4) throw new MessagingError('BRIDGE_HOP_LIMIT', 'Bridge hop limit reached');
  return { targetProvider: input.targetProvider, bridgeTrace: [...trace, input.targetProvider], hopCount: trace.length + 1 };
}

export function verifyEventChain(state) {
  let previousHash = null;
  for (const event of state.events) {
    const { hash, ...base } = event;
    if (base.previousHash !== previousHash) return { ok: false, error: 'EVENT_PREVIOUS_HASH_MISMATCH', eventId: event.id };
    const expected = sha256(canonical(base));
    if (expected !== hash) return { ok: false, error: 'EVENT_HASH_MISMATCH', eventId: event.id };
    previousHash = hash;
  }
  return { ok: state.eventHead === previousHash, events: state.events.length, head: previousHash };
}

export function publicStatus(state) {
  const deliveryStates = Object.fromEntries([...DELIVERY_STATES].map((value) => [value, state.deliveries.filter((item) => item.state === value).length]));
  return {
    schema: 'road-messaging-public-status-v1',
    protocolVersion: PROTOCOL_VERSION,
    revision: state.revision,
    counts: {
      spaces: state.spaces.length,
      threads: state.threads.length,
      openThreads: state.threads.filter((item) => item.state === 'OPEN').length,
      messages: state.messages.length,
      reactions: state.reactions.length,
      deliveries: state.deliveries.length,
      unresolvedDeliveries: state.deliveries.filter((item) => ACTIVE_DELIVERY_STATES.has(item.state)).length,
    },
    deliveryStates,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, value]) => [id, { status: value.status, capabilities: value.capabilities }])),
    secretsPersisted: false,
  };
}

export function doctorState(state) {
  const errors = [];
  const eventChain = verifyEventChain(state);
  if (!eventChain.ok) errors.push(eventChain.error ?? 'EVENT_CHAIN_INVALID');
  const ids = new Set();
  for (const collection of [state.spaces,state.threads,state.messages,state.reactions,state.readMarkers,state.deliveries,state.inboundEvents,state.events]) {
    for (const item of collection) {
      if (ids.has(item.id)) errors.push(`DUPLICATE_ID:${item.id}`);
      ids.add(item.id);
      try { safeText(canonical(item), `state.${item.id}`); } catch (error) { errors.push(error.code); }
    }
  }
  for (const thread of state.threads) if (!state.spaces.some((space) => space.id === thread.spaceId)) errors.push(`ORPHAN_THREAD:${thread.id}`);
  for (const message of state.messages) if (!state.threads.some((thread) => thread.id === message.threadId)) errors.push(`ORPHAN_MESSAGE:${message.id}`);
  return { ok: errors.length === 0, errors, eventChain, status: publicStatus(state) };
}
