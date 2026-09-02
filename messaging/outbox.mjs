import { MessagingError, sha256, stableStringify } from './framework.mjs';

const OUTBOX_STATES = new Set(['PENDING', 'CLAIMED', 'DELIVERED', 'FAILED', 'TIMEOUT_UNKNOWN', 'CANCELLED']);
const BROKER_ACTORS = new Set(['connector-orchestrator', 'agent-instance-4']);

function nowIso(now) {
  return new Date(now || new Date()).toISOString();
}

function ensureOutbox(state) {
  if (!Array.isArray(state.handoffOutbox)) state.handoffOutbox = [];
  return state.handoffOutbox;
}

function itemKey(plan) {
  return sha256(stableStringify({
    type: plan.type,
    fromAgentId: plan.fromAgentId,
    toAgentId: plan.toAgentId,
    connectorId: plan.connectorId,
    resourceKey: plan.resourceKey,
    requestedAction: plan.requestedAction,
    artifactRefs: plan.artifactRefs || [],
    evidenceRefs: plan.evidenceRefs || [],
  }));
}

export function enqueueHandoffPlans(state, plans, options = {}) {
  const next = structuredClone(state);
  const outbox = ensureOutbox(next);
  const created = [];
  const replayed = [];

  for (const plan of plans || []) {
    if (plan.type !== 'handoff.create') throw new MessagingError('OUTBOX_PLAN_INVALID', `Unsupported outbox plan type ${plan.type}`);
    if (!plan.toAgentId || !plan.connectorId || !plan.resourceKey) {
      throw new MessagingError('OUTBOX_PLAN_INCOMPLETE', 'Handoff plan requires toAgentId, connectorId, and resourceKey');
    }
    const key = itemKey(plan);
    const existing = outbox.find((item) => item.semanticKey === key);
    if (existing) {
      replayed.push(existing);
      continue;
    }
    const item = {
      id: `road://messaging-outbox/${key.slice(0, 32)}`,
      semanticKey: key,
      kind: 'COLLABORATION_HANDOFF',
      plan: {
        type: plan.type,
        fromAgentId: plan.fromAgentId,
        toAgentId: plan.toAgentId,
        connectorId: plan.connectorId,
        resourceKey: plan.resourceKey,
        summary: plan.summary || null,
        artifactRefs: [...new Set(plan.artifactRefs || [])],
        evidenceRefs: [...new Set(plan.evidenceRefs || [])],
        requestedAction: plan.requestedAction || 'review',
      },
      state: 'PENDING',
      claim: null,
      deliveryRef: null,
      resultRef: null,
      createdAt: nowIso(options.now),
      updatedAt: nowIso(options.now),
    };
    outbox.push(item);
    created.push(item);
  }

  return { state: next, created, replayed };
}

export function claimOutboxItem(state, input, options = {}) {
  if (!BROKER_ACTORS.has(input.agentId)) {
    throw new MessagingError('OUTBOX_BROKER_REQUIRED', 'Only connector-orchestrator or agent-instance-4 may claim messaging handoff delivery');
  }
  if (!input.sessionRef) throw new MessagingError('SESSION_REF_REQUIRED', 'Outbox claim requires exact sessionRef');
  const next = structuredClone(state);
  const item = ensureOutbox(next).find((entry) => entry.id === input.outboxId);
  if (!item) throw new MessagingError('OUTBOX_ITEM_NOT_FOUND', `Outbox item ${input.outboxId} was not found`);

  if (item.state === 'CLAIMED') {
    if (item.claim.agentId === input.agentId && item.claim.sessionRef === input.sessionRef) {
      return { state: next, item, replay: true };
    }
    throw new MessagingError('OUTBOX_ALREADY_CLAIMED', 'Outbox item is claimed by another runtime session');
  }
  if (item.state !== 'PENDING') {
    throw new MessagingError('OUTBOX_NOT_CLAIMABLE', `Outbox item state ${item.state} is not claimable`);
  }

  const ttlSeconds = Math.max(15, Math.min(900, Number(input.ttlSeconds || 120)));
  item.state = 'CLAIMED';
  item.claim = {
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    claimedAt: nowIso(options.now),
    expiresAt: new Date(new Date(options.now || new Date()).getTime() + ttlSeconds * 1000).toISOString(),
  };
  item.updatedAt = nowIso(options.now);
  return { state: next, item, replay: false };
}

export function reapOutboxClaims(state, options = {}) {
  const next = structuredClone(state);
  const now = new Date(options.now || new Date());
  for (const item of ensureOutbox(next)) {
    if (item.state !== 'CLAIMED' || !item.claim?.expiresAt) continue;
    if (new Date(item.claim.expiresAt) <= now) {
      item.state = 'PENDING';
      item.claim = null;
      item.updatedAt = now.toISOString();
    }
  }
  return next;
}

export function completeOutboxItem(state, input, options = {}) {
  if (!OUTBOX_STATES.has(input.state) || !['DELIVERED', 'FAILED', 'TIMEOUT_UNKNOWN', 'CANCELLED'].includes(input.state)) {
    throw new MessagingError('OUTBOX_RESULT_INVALID', `Unsupported outbox completion state ${input.state}`);
  }
  if (!input.sessionRef) throw new MessagingError('SESSION_REF_REQUIRED', 'Outbox completion requires exact sessionRef');
  const next = structuredClone(state);
  const item = ensureOutbox(next).find((entry) => entry.id === input.outboxId);
  if (!item) throw new MessagingError('OUTBOX_ITEM_NOT_FOUND', `Outbox item ${input.outboxId} was not found`);
  if (item.state !== 'CLAIMED') throw new MessagingError('OUTBOX_NOT_CLAIMED', 'Outbox item must be claimed before completion');
  if (item.claim.agentId !== input.agentId || item.claim.sessionRef !== input.sessionRef) {
    throw new MessagingError('OUTBOX_SESSION_MISMATCH', 'Only the exact claiming runtime session may complete the outbox item');
  }

  item.state = input.state;
  item.deliveryRef = input.deliveryRef || null;
  item.resultRef = input.resultRef || null;
  item.updatedAt = nowIso(options.now);
  item.completedAt = input.state === 'TIMEOUT_UNKNOWN' ? null : nowIso(options.now);
  item.claim = input.state === 'TIMEOUT_UNKNOWN' ? item.claim : null;
  return {
    state: next,
    item,
    releaseClaim: input.state !== 'TIMEOUT_UNKNOWN',
    retryAllowed: false,
    next: input.state === 'TIMEOUT_UNKNOWN' ? 'read-collaboration-broker-before-retry' : null,
  };
}

export function pendingOutboxItems(state) {
  return ensureOutbox(state).filter((item) => item.state === 'PENDING');
}

export function publicOutboxStatus(state) {
  const items = ensureOutbox(state);
  const counts = {};
  for (const value of OUTBOX_STATES) counts[value] = items.filter((item) => item.state === value).length;
  return {
    schema: 'road-messaging-outbox-public-status-v1',
    total: items.length,
    counts,
    privatePlansExposed: false,
  };
}
