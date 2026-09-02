import { MessagingError, sha256, stableStringify } from './framework.mjs';

const AGENT_PATTERN = /^(connector-orchestrator|agent-instance-[1-6])$/;
const INBOX_STATES = new Set(['UNREAD', 'SEEN', 'ACKNOWLEDGED', 'ACTION_REQUIRED', 'DONE', 'DISMISSED']);
const DELIVERY_MODES = new Set(['INBOX', 'HANDOFF', 'OBSERVE']);

export function createEmptyRouterState() {
  return {
    schema: 'road-messaging-router-state-v1',
    revision: 0,
    subscriptions: [],
    inbox: [],
    deliveries: [],
    events: [],
  };
}

function cloneState(state) {
  return structuredClone(state || createEmptyRouterState());
}

function nowIso(now) {
  return new Date(now || new Date()).toISOString();
}

function assertAgent(agentId) {
  if (!AGENT_PATTERN.test(String(agentId || ''))) {
    throw new MessagingError('INVALID_AGENT_ID', `Expected connector-orchestrator or agent-instance-1 through agent-instance-6, received ${agentId || '<missing>'}`);
  }
}

function appendEvent(state, type, payload, now) {
  const event = {
    id: `road://message-event/${sha256(stableStringify({ type, payload, sequence: state.events.length + 1 })).slice(0, 32)}`,
    sequence: state.events.length + 1,
    type,
    timestamp: nowIso(now),
    ...payload,
  };
  state.events.push(event);
  state.revision += 1;
  return event;
}

export function registerSubscription(state, input, options = {}) {
  assertAgent(input.agentId);
  if (!input.sessionRef) throw new MessagingError('SESSION_REF_REQUIRED', 'Subscription requires an exact runtime sessionRef');
  const mode = input.deliveryMode || 'INBOX';
  if (!DELIVERY_MODES.has(mode)) throw new MessagingError('INVALID_DELIVERY_MODE', `Unsupported delivery mode ${mode}`);

  const filter = {
    providerIds: [...new Set((input.providerIds || []).map((value) => String(value).toLowerCase()))],
    threadResources: [...new Set(input.threadResources || [])],
    mentionRefs: [...new Set(input.mentionRefs || [])],
    kinds: [...new Set(input.kinds || [])],
    actionRequiredOnly: Boolean(input.actionRequiredOnly),
  };
  if (
    filter.providerIds.length === 0 &&
    filter.threadResources.length === 0 &&
    filter.mentionRefs.length === 0 &&
    filter.kinds.length === 0
  ) {
    throw new MessagingError('SUBSCRIPTION_FILTER_REQUIRED', 'A subscription must name at least one provider, thread, mention, or message kind');
  }

  const semanticKey = sha256(stableStringify({ agentId: input.agentId, mode, filter }));
  const next = cloneState(state);
  const existing = next.subscriptions.find((item) => item.semanticKey === semanticKey && item.state === 'ACTIVE');
  if (existing) return { state: next, subscription: existing, replay: true };

  const subscription = {
    id: `road://subscription/${semanticKey.slice(0, 32)}`,
    semanticKey,
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    deliveryMode: mode,
    filter,
    state: 'ACTIVE',
    createdAt: nowIso(options.now),
    updatedAt: nowIso(options.now),
  };
  next.subscriptions.push(subscription);
  appendEvent(next, 'road.messaging.subscription.registered', {
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    subscriptionId: subscription.id,
  }, options.now);
  return { state: next, subscription, replay: false };
}

function subscriptionMatches(subscription, input) {
  const filter = subscription.filter;
  const providerMatch = filter.providerIds.length === 0 || filter.providerIds.includes(String(input.providerId || '').toLowerCase());
  const threadMatch = filter.threadResources.length === 0 || filter.threadResources.includes(input.threadResource);
  const mentionRefs = new Set(input.mentionRefs || []);
  const mentionMatch = filter.mentionRefs.length === 0 || filter.mentionRefs.some((ref) => mentionRefs.has(ref));
  const kindMatch = filter.kinds.length === 0 || filter.kinds.includes(input.kind || 'discussion');
  const actionMatch = !filter.actionRequiredOnly || input.actionRequired === true;
  return providerMatch && threadMatch && mentionMatch && kindMatch && actionMatch;
}

function deliveryKey(subscription, input) {
  return sha256(stableStringify({
    subscriptionId: subscription.id,
    providerId: input.providerId,
    providerMessageRef: input.providerMessageRef,
    messageId: input.messageId,
    threadResource: input.threadResource,
  }));
}

export function routeMessage(state, input, options = {}) {
  if (!input.messageId) throw new MessagingError('MESSAGE_ID_REQUIRED', 'Routing requires canonical messageId');
  if (!input.threadResource) throw new MessagingError('THREAD_RESOURCE_REQUIRED', 'Routing requires canonical threadResource');
  if (!input.providerId) throw new MessagingError('PROVIDER_ID_REQUIRED', 'Routing requires providerId');

  const next = cloneState(state);
  const matches = next.subscriptions.filter((subscription) => subscription.state === 'ACTIVE' && subscriptionMatches(subscription, input));
  const created = [];
  const handoffPlans = [];

  for (const subscription of matches) {
    const key = deliveryKey(subscription, input);
    const existing = next.deliveries.find((item) => item.key === key);
    if (existing) continue;

    const delivery = {
      id: `road://delivery/${key.slice(0, 32)}`,
      key,
      subscriptionId: subscription.id,
      agentId: subscription.agentId,
      sessionRef: subscription.sessionRef,
      messageId: input.messageId,
      threadResource: input.threadResource,
      providerId: input.providerId,
      providerMessageRef: input.providerMessageRef || null,
      sourceReceiptRef: input.sourceReceiptRef || null,
      mode: subscription.deliveryMode,
      state: 'DELIVERED',
      deliveredAt: nowIso(options.now),
    };
    next.deliveries.push(delivery);

    const inboxItem = {
      id: `road://inbox/${key.slice(0, 32)}`,
      deliveryId: delivery.id,
      agentId: subscription.agentId,
      sessionRef: subscription.sessionRef,
      messageId: input.messageId,
      threadResource: input.threadResource,
      providerId: input.providerId,
      providerMessageRef: input.providerMessageRef || null,
      sourceReceiptRef: input.sourceReceiptRef || null,
      kind: input.kind || 'discussion',
      priority: input.priority || (input.actionRequired ? 'HIGH' : 'NORMAL'),
      state: input.actionRequired ? 'ACTION_REQUIRED' : 'UNREAD',
      mentionRefs: [...new Set(input.mentionRefs || [])],
      attachmentRefs: [...new Set(input.attachmentRefs || [])],
      bodyRef: input.bodyRef || null,
      bodyHash: input.bodyHash || null,
      createdAt: nowIso(options.now),
      updatedAt: nowIso(options.now),
    };
    next.inbox.push(inboxItem);
    created.push(inboxItem);

    if (subscription.deliveryMode === 'HANDOFF') {
      handoffPlans.push({
        type: 'handoff.create',
        fromAgentId: input.sourceAgentId || 'connector-orchestrator',
        toAgentId: subscription.agentId,
        connectorId: input.providerId,
        resourceKey: input.threadResource,
        summary: input.summary || `Messaging item ${input.messageId} requires attention`,
        artifactRefs: [input.bodyRef, ...(input.attachmentRefs || [])].filter(Boolean),
        evidenceRefs: [input.sourceReceiptRef, input.providerMessageRef].filter(Boolean),
        requestedAction: input.actionRequired ? 'review-and-act' : 'review',
      });
    }

    appendEvent(next, 'road.messaging.inbox.delivered', {
      agentId: subscription.agentId,
      sessionRef: subscription.sessionRef,
      inboxItemId: inboxItem.id,
      messageId: input.messageId,
      deliveryMode: subscription.deliveryMode,
    }, options.now);
  }

  return {
    state: next,
    matchedSubscriptions: matches.map((item) => item.id),
    inboxItems: created,
    handoffPlans,
    delivered: created.length,
  };
}

export function transitionInboxItem(state, input, options = {}) {
  assertAgent(input.agentId);
  if (!input.sessionRef) throw new MessagingError('SESSION_REF_REQUIRED', 'Inbox transition requires sessionRef');
  if (!INBOX_STATES.has(input.state)) throw new MessagingError('INVALID_INBOX_STATE', `Unsupported inbox state ${input.state}`);

  const next = cloneState(state);
  const item = next.inbox.find((entry) => entry.id === input.inboxItemId);
  if (!item) throw new MessagingError('INBOX_ITEM_NOT_FOUND', `Inbox item ${input.inboxItemId} was not found`);
  if (item.agentId !== input.agentId) throw new MessagingError('INBOX_RECIPIENT_MISMATCH', 'Only the addressed agent may transition an inbox item');
  if (item.sessionRef !== input.sessionRef) throw new MessagingError('INBOX_SESSION_MISMATCH', 'Inbox item is bound to another runtime session');
  if (item.state === input.state) return { state: next, item, replay: true, authorityGranted: false };

  const priorState = item.state;
  item.state = input.state;
  item.updatedAt = nowIso(options.now);
  item.resultRef = input.resultRef || item.resultRef || null;
  appendEvent(next, 'road.messaging.inbox.state_changed', {
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    inboxItemId: item.id,
    priorState,
    state: input.state,
    resultRef: input.resultRef || null,
  }, options.now);

  return {
    state: next,
    item,
    replay: false,
    authorityGranted: false,
    satisfiesUserApproval: false,
    satisfiesGovernance: false,
  };
}

export function closeSubscription(state, input, options = {}) {
  assertAgent(input.agentId);
  if (!input.sessionRef) throw new MessagingError('SESSION_REF_REQUIRED', 'Closing a subscription requires sessionRef');
  const next = cloneState(state);
  const subscription = next.subscriptions.find((item) => item.id === input.subscriptionId);
  if (!subscription) throw new MessagingError('SUBSCRIPTION_NOT_FOUND', `Subscription ${input.subscriptionId} was not found`);
  if (subscription.agentId !== input.agentId || subscription.sessionRef !== input.sessionRef) {
    throw new MessagingError('SUBSCRIPTION_OWNER_MISMATCH', 'Only the owning agent session may close a subscription');
  }
  if (subscription.state === 'CLOSED') return { state: next, subscription, replay: true };
  subscription.state = 'CLOSED';
  subscription.updatedAt = nowIso(options.now);
  appendEvent(next, 'road.messaging.subscription.closed', {
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    subscriptionId: subscription.id,
  }, options.now);
  return { state: next, subscription, replay: false };
}

export function inboxForAgent(state, agentId, options = {}) {
  assertAgent(agentId);
  const states = new Set(options.states || [...INBOX_STATES]);
  return state.inbox
    .filter((item) => item.agentId === agentId && states.has(item.state))
    .sort((a, b) => {
      const rank = { HIGH: 0, NORMAL: 1, LOW: 2 };
      const priority = (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
      if (priority !== 0) return priority;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
}

export function publicRouterStatus(state) {
  return {
    schema: 'road-messaging-router-public-status-v1',
    revision: state.revision,
    subscriptions: state.subscriptions.filter((item) => item.state === 'ACTIVE').length,
    inboxItems: state.inbox.length,
    actionRequired: state.inbox.filter((item) => item.state === 'ACTION_REQUIRED').length,
    unread: state.inbox.filter((item) => item.state === 'UNREAD').length,
    done: state.inbox.filter((item) => item.state === 'DONE').length,
    deliveries: state.deliveries.length,
    events: state.events.length,
  };
}
