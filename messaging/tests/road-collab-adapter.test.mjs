import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyMessagingPipelineState } from '../pipeline.mjs';
import { enqueueHandoffPlans } from '../outbox.mjs';
import {
  finishRoadCollabHandoff,
  prepareRoadCollabHandoff,
  roadCollabDrainPlan,
} from '../road-collab-adapter.mjs';

const handoffPlan = {
  type: 'handoff.create',
  fromAgentId: 'connector-orchestrator',
  toAgentId: 'agent-instance-4',
  connectorId: 'slack',
  resourceKey: 'road+message://slack/team/T/channel/C/thread/1',
  summary: 'Message requires review',
  artifactRefs: ['slack:message:1/content'],
  evidenceRefs: ['road://verification/slack/1'],
  requestedAction: 'review-and-act',
};

function enqueuedState() {
  return enqueueHandoffPlans(createEmptyMessagingPipelineState(), [handoffPlan]).state;
}

test('drain plan exposes hashes and routing metadata, not private handoff body', () => {
  const plan = roadCollabDrainPlan(enqueuedState());
  assert.equal(plan.length, 1);
  assert.equal(plan[0].targetAgentId, 'agent-instance-4');
  assert.equal(plan[0].privatePlanExposed, false);
  assert.equal(Object.hasOwn(plan[0], 'summary'), false);
  assert.equal(Object.hasOwn(plan[0], 'artifactRefs'), false);
});

test('preparing delivery claims exact outbox item and creates road-collab command', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const prepared = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.equal(prepared.mayCallBroker, true);
  assert.equal(prepared.broker.service, 'road://service/collaboration');
  assert.equal(prepared.broker.command.type, 'handoff.create');
  assert.equal(prepared.broker.command.toAgentId, 'agent-instance-4');
  assert.match(prepared.broker.command.idempotencyKey, /^messaging-handoff:/);
  assert.match(prepared.broker.command.requestHash, /^[a-f0-9]{64}$/);
});

test('identical prepare from same broker session replays claim', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const first = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const second = prepareRoadCollabHandoff(first.state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.equal(second.replay, true);
  assert.equal(second.broker.command.requestHash, first.broker.command.requestHash);
});

test('successful broker response is insufficient without read-back verification', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const prepared = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.throws(
    () => finishRoadCollabHandoff(prepared.state, {
      outboxId,
      agentId: 'connector-orchestrator',
      sessionRef: 'broker-session-a',
      kind: 'success',
      handoffRef: 'road://handoff/1',
    }),
    (error) => error.code === 'HANDOFF_VERIFICATION_REQUIRED',
  );
});

test('verified broker handoff marks outbox item delivered', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const prepared = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const finished = finishRoadCollabHandoff(prepared.state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
    kind: 'success',
    handoffRef: 'road://handoff/1',
    verificationRef: 'road://handoff/1/readback',
  });
  assert.equal(finished.item.state, 'DELIVERED');
  assert.equal(finished.item.deliveryRef, 'road://handoff/1');
  assert.equal(finished.item.resultRef, 'road://handoff/1/readback');
});

test('broker timeout remains unknown and keeps claim', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const prepared = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  const finished = finishRoadCollabHandoff(prepared.state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
    kind: 'timeout',
    brokerRequestRef: 'road-collab:request:unknown',
  });
  assert.equal(finished.item.state, 'TIMEOUT_UNKNOWN');
  assert.equal(finished.releaseClaim, false);
  assert.equal(finished.retryAllowed, false);
  assert.equal(finished.item.claim.sessionRef, 'broker-session-a');
});

test('another broker session cannot complete claimed delivery', () => {
  const state = enqueuedState();
  const outboxId = state.handoffOutbox[0].id;
  const prepared = prepareRoadCollabHandoff(state, {
    outboxId,
    agentId: 'connector-orchestrator',
    sessionRef: 'broker-session-a',
  });
  assert.throws(
    () => finishRoadCollabHandoff(prepared.state, {
      outboxId,
      agentId: 'connector-orchestrator',
      sessionRef: 'broker-session-b',
      kind: 'failed',
      resultRef: 'failure:1',
    }),
    (error) => error.code === 'OUTBOX_SESSION_MISMATCH',
  );
});
