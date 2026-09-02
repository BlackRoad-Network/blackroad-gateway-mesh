import {
  MessagingError,
  canonicalThreadResource,
  classifyOutcome,
  normalizeInboundMessage,
  planMirror,
  reactionMeaning,
  sha256,
  stableStringify,
} from './framework.mjs';

export function createEmptyMessagingState() {
  return {
    schema: 'road-messaging-state-v1',
    revision: 0,
    threads: [],
    messages: [],
    reactions: [],
    projections: [],
    events: [],
  };
}

function cloneState(state) {
  return structuredClone(state || createEmptyMessagingState());
}

function nowIso(now) {
  return new Date(now || new Date()).toISOString();
}

function eventHash(event) {
  const unsigned = { ...event };
  delete unsigned.hash;
  return sha256(stableStringify(unsigned));
}

function appendEvent(state, input, options = {}) {
  const previous = state.events.at(-1) || null;
  const event = {
    id: input.id || `msgevt_${sha256(stableStringify({ input, sequence: state.events.length + 1 })).slice(0, 24)}`,
    sequence: state.events.length + 1,
    type: input.type,
    timestamp: nowIso(options.now),
    actorRef: input.actorRef || null,
    providerId: input.providerId || null,
    threadId: input.threadId || null,
    messageId: input.messageId || null,
    projectionId: input.projectionId || null,
    payloadRefs: Array.isArray(input.payloadRefs) ? input.payloadRefs : [],
    summary: input.summary || null,
    previousHash: previous?.hash || null,
  };
  event.hash = eventHash(event);
  state.events.push(event);
  state.revision += 1;
  return event;
}

function threadIdFor(resourceKey) {
  return `road://thread/${sha256(resourceKey).slice(0, 32)}`;
}

function messageKey(providerId, providerMessageRef) {
  return `${String(providerId).toLowerCase()}::${String(providerMessageRef)}`;
}

export function ingestProviderMessage(state, input, options = {}) {
  const next = cloneState(state);
  const normalized = normalizeInboundMessage(input);
  const durable = normalized.durable;
  const threadResource = durable.threadResource;
  const threadId = threadIdFor(threadResource);
  const key = messageKey(durable.providerId, durable.providerMessageRef);

  let thread = next.threads.find((item) => item.id === threadId);
  if (!thread) {
    thread = {
      id: threadId,
      authority: {
        providerId: durable.providerId,
        resourceKey: threadResource,
      },
      kind: input.kind || 'discussion',
      state: 'OPEN',
      subject: input.subject || null,
      participantRefs: Array.isArray(input.participantRefs) ? [...new Set(input.participantRefs)] : [],
      createdAt: input.createdAt || nowIso(options.now),
      updatedAt: input.updatedAt || null,
    };
    next.threads.push(thread);
    appendEvent(next, {
      type: 'road.messaging.thread.discovered',
      actorRef: input.actorRef || null,
      providerId: durable.providerId,
      threadId,
      payloadRefs: [threadResource],
      summary: 'Discovered authoritative provider thread',
    }, options);
  } else if (
    thread.authority.providerId !== durable.providerId ||
    thread.authority.resourceKey !== threadResource
  ) {
    throw new MessagingError('THREAD_AUTHORITY_CONFLICT', `Thread ${threadId} already has another authority`);
  }

  const existing = next.messages.find((item) => item.messageKey === key);
  if (existing && existing.threadResource !== threadResource) {
    throw new MessagingError('MESSAGE_THREAD_CONFLICT', `Provider message ${key} appeared in two threads`);
  }

  if (existing && existing.bodyHash === durable.bodyHash && existing.providerVersionRef === durable.providerVersionRef) {
    return { state: next, thread, message: existing, replay: true, updated: false };
  }

  if (existing) {
    existing.revisions = Array.isArray(existing.revisions) ? existing.revisions : [];
    existing.revisions.push({
      bodyRef: existing.bodyRef,
      bodyHash: existing.bodyHash,
      bodyLength: existing.bodyLength,
      providerVersionRef: existing.providerVersionRef,
      observedAt: nowIso(options.now),
    });
    Object.assign(existing, durable, {
      messageKey: key,
      threadId,
      observedAt: nowIso(options.now),
      revisions: existing.revisions,
    });
    thread.updatedAt = durable.updatedAt || nowIso(options.now);
    appendEvent(next, {
      type: 'road.messaging.message.revised',
      actorRef: input.actorRef || durable.authorRef || null,
      providerId: durable.providerId,
      threadId,
      messageId: existing.id,
      payloadRefs: [durable.bodyRef],
      summary: 'Observed a provider-native message revision',
    }, options);
    return { state: next, thread, message: existing, replay: false, updated: true };
  }

  const message = {
    ...durable,
    messageKey: key,
    threadId,
    observedAt: nowIso(options.now),
    revisions: [],
  };
  next.messages.push(message);
  appendEvent(next, {
    type: 'road.messaging.message.ingested',
    actorRef: input.actorRef || durable.authorRef || null,
    providerId: durable.providerId,
    threadId,
    messageId: message.id,
    payloadRefs: [durable.bodyRef],
    summary: 'Ingested provider-native message metadata',
  }, options);
  return { state: next, thread, message, replay: false, updated: false };
}

export function recordReaction(state, input, options = {}) {
  const next = cloneState(state);
  const message = next.messages.find((item) => item.id === input.messageId);
  if (!message) throw new MessagingError('MESSAGE_NOT_FOUND', `Message ${input.messageId} was not found`);
  if (!input.actorRef) throw new MessagingError('ACTOR_REF_REQUIRED', 'Reaction actorRef is required');

  const semantics = reactionMeaning(input.emoji);
  const key = `${message.id}::${input.actorRef}::${semantics.emoji}`;
  const existing = next.reactions.find((item) => item.key === key);
  if (existing) return { state: next, reaction: existing, replay: true };

  const reaction = {
    id: `road://reaction/${sha256(key).slice(0, 32)}`,
    key,
    messageId: message.id,
    threadId: message.threadId,
    providerId: input.providerId || message.providerId,
    providerReactionRef: input.providerReactionRef || null,
    actorRef: input.actorRef,
    emoji: semantics.emoji,
    meaning: semantics.meaning,
    grantsAuthority: false,
    satisfiesGovernance: false,
    satisfiesUserApproval: false,
    createdAt: input.createdAt || nowIso(options.now),
  };
  next.reactions.push(reaction);
  appendEvent(next, {
    type: 'road.messaging.reaction.recorded',
    actorRef: input.actorRef,
    providerId: reaction.providerId,
    threadId: reaction.threadId,
    messageId: reaction.messageId,
    payloadRefs: reaction.providerReactionRef ? [reaction.providerReactionRef] : [],
    summary: `Recorded ${reaction.meaning} social signal`,
  }, options);
  return { state: next, reaction, replay: false };
}

export function setThreadState(state, input, options = {}) {
  const next = cloneState(state);
  const thread = next.threads.find((item) => item.id === input.threadId);
  if (!thread) throw new MessagingError('THREAD_NOT_FOUND', `Thread ${input.threadId} was not found`);
  if (thread.authority.providerId !== input.providerId) {
    throw new MessagingError('THREAD_AUTHORITY_REQUIRED', 'Only the authoritative provider observation may change thread state');
  }
  if (!['OPEN', 'RESOLVED', 'ARCHIVED'].includes(input.state)) {
    throw new MessagingError('INVALID_THREAD_STATE', `Unsupported thread state ${input.state}`);
  }
  if (thread.state === input.state) return { state: next, thread, replay: true };
  thread.state = input.state;
  thread.updatedAt = nowIso(options.now);
  appendEvent(next, {
    type: 'road.messaging.thread.state_changed',
    actorRef: input.actorRef || null,
    providerId: input.providerId,
    threadId: thread.id,
    payloadRefs: input.evidenceRef ? [input.evidenceRef] : [],
    summary: `Thread state changed to ${input.state}`,
  }, options);
  return { state: next, thread, replay: false };
}

export function createMirrorProjection(state, input, options = {}) {
  const next = cloneState(state);
  const plan = planMirror(input);
  if (plan.state !== 'READY') return { state: next, plan, projection: null, created: false };

  const existing = next.projections.find((item) => item.dedupeKey === plan.dedupeKey);
  if (existing) return { state: next, plan, projection: existing, created: false, replay: true };

  const projection = {
    id: `road://projection/${plan.dedupeKey.slice(0, 32)}`,
    authority: plan.authority,
    projection: plan.projection,
    direction: 'OUTBOUND_PROJECTION',
    bidirectional: false,
    bodyHash: plan.bodyHash,
    lineage: plan.lineage,
    dedupeKey: plan.dedupeKey,
    state: 'READY',
    providerRequestRef: null,
    verificationRef: null,
    createdAt: nowIso(options.now),
    updatedAt: nowIso(options.now),
  };
  next.projections.push(projection);
  appendEvent(next, {
    type: 'road.messaging.projection.created',
    actorRef: input.actorRef || null,
    providerId: projection.projection.providerId,
    projectionId: projection.id,
    payloadRefs: [projection.authority.resourceKey, projection.projection.resourceKey],
    summary: 'Created one-way provider projection',
  }, options);
  return { state: next, plan, projection, created: true, replay: false };
}

export function recordProjectionOutcome(state, input, options = {}) {
  const next = cloneState(state);
  const projection = next.projections.find((item) => item.id === input.projectionId);
  if (!projection) throw new MessagingError('PROJECTION_NOT_FOUND', `Projection ${input.projectionId} was not found`);

  const outcome = classifyOutcome({
    kind: input.kind,
    mutating: true,
    verificationMatched: input.verificationMatched,
  });
  projection.state = outcome.state;
  projection.providerRequestRef = input.providerRequestRef || projection.providerRequestRef;
  projection.verificationRef = input.verificationRef || projection.verificationRef;
  projection.updatedAt = nowIso(options.now);

  appendEvent(next, {
    type: 'road.messaging.projection.outcome_recorded',
    actorRef: input.actorRef || null,
    providerId: projection.projection.providerId,
    projectionId: projection.id,
    payloadRefs: [input.providerRequestRef, input.verificationRef].filter(Boolean),
    summary: `Projection outcome ${outcome.state}`,
  }, options);
  return { state: next, projection, outcome };
}

export function verifyEventChain(state) {
  let previousHash = null;
  for (let index = 0; index < state.events.length; index += 1) {
    const event = state.events[index];
    if (event.sequence !== index + 1) {
      return { ok: false, index, reason: 'EVENT_SEQUENCE_MISMATCH' };
    }
    if (event.previousHash !== previousHash) {
      return { ok: false, index, reason: 'EVENT_PREVIOUS_HASH_MISMATCH' };
    }
    if (event.hash !== eventHash(event)) {
      return { ok: false, index, reason: 'EVENT_HASH_MISMATCH' };
    }
    previousHash = event.hash;
  }
  return { ok: true, events: state.events.length, headHash: previousHash };
}

export function publicMessagingStatus(state) {
  const verifiedProjections = state.projections.filter((item) => item.state === 'VERIFIED').length;
  const unknownProjections = state.projections.filter((item) => item.state === 'TIMEOUT_UNKNOWN').length;
  return {
    schema: 'road-messaging-public-status-v1',
    revision: state.revision,
    threads: state.threads.length,
    openThreads: state.threads.filter((item) => item.state === 'OPEN').length,
    resolvedThreads: state.threads.filter((item) => item.state === 'RESOLVED').length,
    messages: state.messages.length,
    reactions: state.reactions.length,
    projections: state.projections.length,
    verifiedProjections,
    unknownProjections,
    eventChain: verifyEventChain(state),
  };
}
