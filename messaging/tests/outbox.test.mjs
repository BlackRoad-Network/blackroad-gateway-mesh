import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimOutboxItem,
  completeOutboxItem,
  enqueueHandoffPlans,
  pendingOutboxItems,
  publicOutboxStatus,
  reapOutboxClaims,
} from '../outbox.mjs';
import { createEmptyMessagingPipelineState } from '../pipeline.mjs';

const plan = {
  type: 'handoff.create',
  fromAgentId: 'connector-orchestrator',
  toAgentId: 'agent-instance-4',
  connectorId: 'github',
  resourceKey: 'road+message://github/repository/o/r/pr/4',
  summary: 'Review the discussion',
  artifactRefs: ['github:comment:1/content'],
  evidenceRefs: ['github:delivery:1'],
  requestedAction: 'review-and-act',
};

test('enqueues a reference-only collaboration handoff plan', () => {
  const result = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan], { now: '2026-09-02T16:00:00Z' });
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].state, 'PENDING');
  assert.equal(result.created[0].kind, 'COLLABORATION_HANDOFF');
  assert.equal(Object.hasOwn(result.created[0].plan, 'body'), false);
});

test('semantic duplicate handoff plan replays', () => {
  const first = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const second = enqueueHandoffPlans(first.state, [plan]);
  assert.equal(second.created.length, 0);
  assert.equal(second.replayed.length, 1);
  assert.equal(second.state.handoffOutbox.length, 1);
});

test('only connector broker or integration steward can claim delivery', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  assert.throws(
    () => claimOutboxItem(enqueued.state, {
      outboxId: enqueued.created[0].id,
      agentId: 'agent-instance-2',
      sessionRef: 'session-2',
    }),
    (error) => error.code === 'OUTBOX_BROKER_REQUIRED',
  );
});

test('exact broker session claims one outbox item', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const claimed = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  }, { now: '2026-09-02T16:00:00Z' });
  assert.equal(claimed.item.state, 'CLAIMED');
  assert.equal(claimed.item.claim.sessionRef, 'broker-session-a');
});

test('same broker session replays existing claim', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const first = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const second = claimOutboxItem(first.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.equal(second.replay, true);
});

test('another session cannot steal active outbox claim', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const first = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.throws(
    () => claimOutboxItem(first.state, {
      outboxId: enqueued.created[0].id,
      agentId: 'agent-instance-4',
      sessionRef: 'broker-session-b',
    }),
    (error) => error.code === 'OUTBOX_ALREADY_CLAIMED',
  );
});

test('delivered handoff releases outbox claim', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const claimed = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const completed = completeOutboxItem(claimed.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
    state: 'DELIVERED',
    deliveryRef: 'road-collab:handoff:1',
    resultRef: 'road-collab:receipt:1',
  });
  assert.equal(completed.item.state, 'DELIVERED');
  assert.equal(completed.releaseClaim, true);
  assert.equal(completed.item.claim, null);
});

test('timeout keeps outbox claim and disallows blind retry', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const claimed = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const completed = completeOutboxItem(claimed.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
    state: 'TIMEOUT_UNKNOWN',
    deliveryRef: 'road-collab:request:unknown',
  });
  assert.equal(completed.item.state, 'TIMEOUT_UNKNOWN');
  assert.equal(completed.releaseClaim, false);
  assert.equal(completed.retryAllowed, false);
  assert.equal(completed.item.claim.sessionRef, 'broker-session-a');
});

test('expired outbox claim returns to pending', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const claimed = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
    ttlSeconds: 15,
  }, { now: '2026-09-02T16:00:00Z' });
  const reaped = reapOutboxClaims(claimed.state, { now: '2026-09-02T16:00:16Z' });
  assert.equal(reaped.handoffOutbox[0].state, 'PENDING');
  assert.equal(reaped.handoffOutbox[0].claim, null);
});

test('public outbox status exposes counts but not private plans', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  const status = publicOutboxStatus(enqueued.state);
  assert.equal(status.total, 1);
  assert.equal(status.counts.PENDING, 1);
  assert.equal(status.privatePlansExposed, false);
  assert.equal(Object.hasOwn(status, 'items'), false);
});

test('pending outbox query returns only unclaimed work', () => {
  const enqueued = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [plan]);
  assert.equal(pendingOutboxItems(enqueued.state).length, 1);
  const claimed = claimOutboxItem(enqueued.state, {
    outboxId: enqueued.created[0].id,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.equal(pendingOutboxItems(claimed.state).length, 0);
});
