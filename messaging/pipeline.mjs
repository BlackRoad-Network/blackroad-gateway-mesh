import { MessagingError, reactionMeaning } from './framework.mjs';
import { durableInboundEvent, inboundDedupeKey } from './inbound.mjs';
import { resolveInboundMention } from './mentions.mjs';
import {
  createEmptyMessagingState,
  ingestProviderMessage,
  recordReaction,
  setThreadState,
} from './state.mjs';
import { createEmptyRouterState, routeMessage } from './router.mjs';

export function createEmptyMessagingPipelineState() {
  return {
    schema: 'road-messaging-pipeline-state-v1',
    revision: 0,
    inboundEvents: [],
    pendingEvents: [],
    deletions: [],
    messaging: createEmptyMessagingState(),
    router: createEmptyRouterState(),
  };
}

function cloneState(state) {
  return structuredClone(state || createEmptyMessagingPipelineState());
}

function nowIso(now) {
  return new Date(now || new Date()).toISOString();
}

function requireVerified(event) {
  if (event?.verification?.verified !== true || !event.verification.verificationRef) {
    throw new MessagingError('INBOUND_EVENT_UNVERIFIED', 'Inbound event requires verified provider evidence');
  }
}

function canonicalMentions(event, identityMap) {
  const resolved = [];
  const unresolved = [];
  for (const providerIdentity of event.providerMentionIds || []) {
    const result = resolveInboundMention(event.providerId, providerIdentity, identityMap || { identities: [] });
    if (result.state === 'RESOLVED') resolved.push(result.mentionRef);
    else unresolved.push(providerIdentity);
  }
  return {
    mentionRefs: [...new Set([...(event.mentionRefs || []), ...resolved])],
    unresolvedProviderMentionIds: [...new Set(unresolved)],
  };
}

function findMessage(state, event) {
  return state.messaging.messages.find((message) =>
    message.providerId === event.providerId &&
    message.providerMessageRef === event.providerMessageRef
  ) || null;
}

function findThread(state, event) {
  return state.messaging.threads.find((thread) =>
    thread.authority.providerId === event.providerId &&
    thread.authority.resourceKey === event.threadResource
  ) || null;
}

function pending(next, event, reason, options) {
  const item = {
    id: `road://pending-message-event/${inboundDedupeKey(event).slice(0, 32)}`,
    dedupeKey: inboundDedupeKey(event),
    providerId: event.providerId,
    eventId: event.eventId,
    type: event.type,
    threadResource: event.threadResource || null,
    providerMessageRef: event.providerMessageRef || null,
    reason,
    verificationRef: event.verification.verificationRef,
    state: 'PENDING',
    createdAt: nowIso(options.now),
  };
  next.pendingEvents.push(item);
  return item;
}

export function processInboundEvent(state, event, options = {}) {
  requireVerified(event);
  const next = cloneState(state);
  const dedupeKey = inboundDedupeKey(event);
  const existing = next.inboundEvents.find((item) => item.dedupeKey === dedupeKey);
  if (existing) {
    return {
      state: next,
      replay: true,
      inboundEvent: existing,
      result: { state: 'ALREADY_PROCESSED' },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  const mentions = canonicalMentions(event, options.identityMap);
  const stored = {
    ...durableInboundEvent(event),
    dedupeKey,
    mentionRefs: mentions.mentionRefs,
    unresolvedProviderMentionIds: mentions.unresolvedProviderMentionIds,
    processedAt: nowIso(options.now),
  };
  next.inboundEvents.push(stored);
  next.revision += 1;

  if (event.type === 'HANDSHAKE' || event.type === 'UNSUPPORTED_EVENT') {
    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: { state: event.type },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  if (['MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MENTION_RECEIVED'].includes(event.type)) {
    if (!event.providerMessageRef) throw new MessagingError('MESSAGE_REF_REQUIRED', `${event.type} requires providerMessageRef`);
    const ingested = ingestProviderMessage(next.messaging, {
      providerId: event.providerId,
      target: event.target,
      providerMessageRef: event.providerMessageRef,
      parentProviderMessageRef: event.parentProviderMessageRef || null,
      authorRef: event.authorRef || null,
      body: event.body || '',
      bodyRef: event.bodyRef || null,
      mentions: mentions.mentionRefs,
      attachmentRefs: event.attachmentRefs || [],
      providerVersionRef: event.providerVersionRef || null,
      createdAt: event.createdAt || null,
      updatedAt: event.updatedAt || null,
      kind: event.kind || (event.type === 'MENTION_RECEIVED' ? 'discussion' : 'discussion'),
      subject: event.subject || null,
      participantRefs: event.participantRefs || [],
      actorRef: event.authorRef || null,
    }, options);
    next.messaging = ingested.state;

    const routed = routeMessage(next.router, {
      messageId: ingested.message.id,
      threadResource: ingested.thread.authority.resourceKey,
      providerId: event.providerId,
      providerMessageRef: event.providerMessageRef,
      sourceReceiptRef: event.verification.verificationRef,
      sourceAgentId: options.sourceAgentId || 'connector-orchestrator',
      kind: event.kind || 'discussion',
      actionRequired: event.actionRequired === true || event.type === 'MENTION_RECEIVED',
      mentionRefs: mentions.mentionRefs,
      attachmentRefs: event.attachmentRefs || [],
      bodyRef: ingested.message.bodyRef,
      bodyHash: ingested.message.bodyHash,
      summary: event.summary || null,
      priority: event.priority || null,
    }, options);
    next.router = routed.state;

    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: {
        state: ingested.updated ? 'MESSAGE_UPDATED' : 'MESSAGE_INGESTED',
        messageId: ingested.message.id,
        threadId: ingested.thread.id,
        rawBodyPersisted: false,
        bodyPersisted: false,
      },
      inboxItems: routed.inboxItems,
      handoffPlans: routed.handoffPlans,
    };
  }

  if (event.type === 'MESSAGE_DELETED') {
    const message = findMessage(next, event);
    const deletion = {
      id: `road://message-deletion/${dedupeKey.slice(0, 32)}`,
      providerId: event.providerId,
      providerMessageRef: event.providerMessageRef || null,
      messageId: message?.id || null,
      threadResource: event.threadResource || message?.threadResource || null,
      verificationRef: event.verification.verificationRef,
      deletedAt: event.updatedAt || nowIso(options.now),
      state: message ? 'APPLIED' : 'PENDING_PARENT',
    };
    next.deletions.push(deletion);
    if (message) {
      message.state = 'DELETED';
      message.deletedAt = deletion.deletedAt;
      message.currentBodyAvailable = false;
    } else {
      pending(next, event, 'MESSAGE_NOT_INGESTED', options);
    }
    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: { state: deletion.state, deletionId: deletion.id },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  if (event.type === 'REACTION_ADDED') {
    const message = findMessage(next, event);
    if (!message) {
      const pendingEvent = pending(next, event, 'REACTION_PARENT_MESSAGE_NOT_INGESTED', options);
      return {
        state: next,
        replay: false,
        inboundEvent: stored,
        result: { state: 'PENDING_PARENT', pendingEventId: pendingEvent.id },
        inboxItems: [],
        handoffPlans: [],
      };
    }
    const reacted = recordReaction(next.messaging, {
      messageId: message.id,
      actorRef: event.reactionActorRef || event.authorRef,
      emoji: event.reaction,
      providerId: event.providerId,
      providerReactionRef: event.providerReactionRef || null,
      createdAt: event.createdAt || null,
    }, options);
    next.messaging = reacted.state;
    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: { state: 'REACTION_RECORDED', reactionId: reacted.reaction.id },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  if (event.type === 'REACTION_REMOVED') {
    const message = findMessage(next, event);
    if (!message) {
      const pendingEvent = pending(next, event, 'REACTION_PARENT_MESSAGE_NOT_INGESTED', options);
      return {
        state: next,
        replay: false,
        inboundEvent: stored,
        result: { state: 'PENDING_PARENT', pendingEventId: pendingEvent.id },
        inboxItems: [],
        handoffPlans: [],
      };
    }
    const semantics = reactionMeaning(event.reaction);
    const reaction = next.messaging.reactions.find((item) =>
      item.messageId === message.id &&
      item.actorRef === (event.reactionActorRef || event.authorRef) &&
      item.emoji === semantics.emoji &&
      item.state !== 'REMOVED'
    );
    if (!reaction) {
      const pendingEvent = pending(next, event, 'REACTION_NOT_INGESTED', options);
      return {
        state: next,
        replay: false,
        inboundEvent: stored,
        result: { state: 'PENDING_PARENT', pendingEventId: pendingEvent.id },
        inboxItems: [],
        handoffPlans: [],
      };
    }
    reaction.state = 'REMOVED';
    reaction.removedAt = event.updatedAt || nowIso(options.now);
    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: { state: 'REACTION_REMOVED', reactionId: reaction.id },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  if (event.type === 'THREAD_RESOLVED' || event.type === 'THREAD_REOPENED') {
    const thread = findThread(next, event);
    if (!thread) {
      const pendingEvent = pending(next, event, 'THREAD_NOT_INGESTED', options);
      return {
        state: next,
        replay: false,
        inboundEvent: stored,
        result: { state: 'PENDING_PARENT', pendingEventId: pendingEvent.id },
        inboxItems: [],
        handoffPlans: [],
      };
    }
    const transitioned = setThreadState(next.messaging, {
      threadId: thread.id,
      providerId: event.providerId,
      state: event.type === 'THREAD_RESOLVED' ? 'RESOLVED' : 'OPEN',
      actorRef: event.authorRef || null,
      evidenceRef: event.verification.verificationRef,
    }, options);
    next.messaging = transitioned.state;
    return {
      state: next,
      replay: false,
      inboundEvent: stored,
      result: { state: event.type, threadId: transitioned.thread.id },
      inboxItems: [],
      handoffPlans: [],
    };
  }

  return {
    state: next,
    replay: false,
    inboundEvent: stored,
    result: { state: 'UNSUPPORTED_EVENT' },
    inboxItems: [],
    handoffPlans: [],
  };
}

export function pipelinePublicStatus(state) {
  return {
    schema: 'road-messaging-pipeline-public-status-v1',
    revision: state.revision,
    inboundEvents: state.inboundEvents.length,
    pendingEvents: state.pendingEvents.filter((item) => item.state === 'PENDING').length,
    deletions: state.deletions.length,
    threads: state.messaging.threads.length,
    messages: state.messaging.messages.length,
    reactions: state.messaging.reactions.filter((item) => item.state !== 'REMOVED').length,
    inboxItems: state.router.inbox.length,
    actionRequired: state.router.inbox.filter((item) => item.state === 'ACTION_REQUIRED').length,
    rawBodiesPersisted: false,
    secretValuesPersisted: false,
  };
}
