import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyMessagingPipelineState,
  pipelinePublicStatus,
  processInboundEvent,
} from '../pipeline.mjs';
import { registerSubscription } from '../router.mjs';

const verification = {
  providerId: 'slack',
  verified: true,
  verificationMode: 'hmac-sha256-v0',
  verificationRef: 'road://verification/slack/verified-1',
  rawBodyHash: 'a'.repeat(64),
  secretPersisted: false,
};

function messageEvent(overrides = {}) {
  return {
    schema: 'road-messaging-inbound-event-v1',
    eventId: 'Ev1',
    providerId: 'slack',
    type: 'MESSAGE_CREATED',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1788364800.123456' },
    threadResource: 'road+message://slack/team/T1/channel/C1/thread/1788364800.123456',
    providerMessageRef: '1788364800.123456',
    parentProviderMessageRef: null,
    authorRef: 'slack:actor:U1',
    providerMentionIds: [],
    body: 'hello',
    bodyRef: 'slack:message:1788364800.123456/content',
    bodyHash: 'unused-by-pipeline',
    bodyLength: 5,
    providerVersionRef: '1788364800.123456',
    createdAt: '2026-09-02T16:00:00Z',
    updatedAt: null,
    verification,
    rawBodyPersisted: false,
    bodyPersisted: false,
    ...overrides,
  };
}

const identityMap = {
  identities: [
    {
      ref: 'road://agent/agent-instance-4',
      providers: { slack: { kind: 'user', id: 'U4' } },
    },
  ],
};

test('rejects an unverified inbound event before state mutation', () => {
  assert.throws(
    () => processInboundEvent(createEmptyMessagingPipelineState(), {
      ...messageEvent(),
      verification: { verified: false },
    }),
    (error) => error.code === 'INBOUND_EVENT_UNVERIFIED',
  );
});

test('verified message is ingested without durable raw body', () => {
  const result = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  assert.equal(result.result.state, 'MESSAGE_INGESTED');
  assert.equal(result.state.messaging.messages.length, 1);
  assert.equal(Object.hasOwn(result.state.messaging.messages[0], 'body'), false);
  assert.equal(Object.hasOwn(result.state.inboundEvents[0], 'body'), false);
  assert.equal(result.result.rawBodyPersisted, false);
  assert.equal(result.result.bodyPersisted, false);
});

test('duplicate verified delivery is replayed without duplicate state', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const second = processInboundEvent(first.state, messageEvent(), { now: '2026-09-02T16:00:02Z' });
  assert.equal(second.replay, true);
  assert.equal(second.state.inboundEvents.length, 1);
  assert.equal(second.state.messaging.messages.length, 1);
});

test('message update records provider-native revision', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const second = processInboundEvent(first.state, messageEvent({
    eventId: 'Ev2',
    type: 'MESSAGE_UPDATED',
    body: 'edited',
    bodyRef: 'slack:message:1788364800.123456/content?v=2',
    providerVersionRef: '1788364801.000001',
    updatedAt: '2026-09-02T16:00:02Z',
  }), { now: '2026-09-02T16:00:02Z' });
  assert.equal(second.result.state, 'MESSAGE_UPDATED');
  assert.equal(second.state.messaging.messages[0].revisions.length, 1);
  assert.equal(Object.hasOwn(second.state.messaging.messages[0], 'body'), false);
});

test('provider message mention routes to exact-session agent inbox and handoff', () => {
  const initial = createEmptyMessagingPipelineState();
  const subscribed = registerSubscription(initial.router, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['slack'],
    mentionRefs: ['road://agent/agent-instance-4'],
    deliveryMode: 'HANDOFF',
  });
  initial.router = subscribed.state;

  const result = processInboundEvent(initial, messageEvent({
    eventId: 'EvMention',
    type: 'MENTION_RECEIVED',
    providerMentionIds: ['U4'],
    body: '<@U4> please review',
  }), { identityMap, now: '2026-09-02T16:00:01Z' });

  assert.equal(result.inboxItems.length, 1);
  assert.equal(result.inboxItems[0].agentId, 'agent-instance-4');
  assert.equal(result.inboxItems[0].sessionRef, 'session-agent4-a');
  assert.equal(result.inboxItems[0].state, 'ACTION_REQUIRED');
  assert.equal(result.handoffPlans[0].toAgentId, 'agent-instance-4');
});

test('unmapped provider mention is preserved as unresolved evidence without guessing', () => {
  const result = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent({
    eventId: 'EvUnknownMention',
    type: 'MENTION_RECEIVED',
    providerMentionIds: ['U999'],
    body: '<@U999> hello',
  }), { identityMap, now: '2026-09-02T16:00:01Z' });
  assert.deepEqual(result.inboundEvent.mentionRefs, []);
  assert.deepEqual(result.inboundEvent.unresolvedProviderMentionIds, ['U999']);
});

test('message deletion marks known message deleted without storing deleted body', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const deleted = processInboundEvent(first.state, messageEvent({
    eventId: 'EvDelete',
    type: 'MESSAGE_DELETED',
    body: '',
    bodyRef: null,
    providerVersionRef: 'delete-v1',
    updatedAt: '2026-09-02T16:00:02Z',
  }), { now: '2026-09-02T16:00:02Z' });
  assert.equal(deleted.result.state, 'APPLIED');
  assert.equal(deleted.state.messaging.messages[0].state, 'DELETED');
  assert.equal(deleted.state.messaging.messages[0].currentBodyAvailable, false);
  assert.equal(deleted.state.deletions[0].verificationRef, verification.verificationRef);
});

test('deletion before parent ingestion remains pending rather than inventing success', () => {
  const deleted = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent({
    eventId: 'EvDeleteFirst',
    type: 'MESSAGE_DELETED',
    body: '',
  }));
  assert.equal(deleted.result.state, 'PENDING_PARENT');
  assert.equal(deleted.state.pendingEvents.length, 1);
});

test('reaction before parent ingestion remains pending', () => {
  const reacted = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent({
    eventId: 'EvReactionFirst',
    type: 'REACTION_ADDED',
    body: '',
    reaction: 'eyes',
    reactionActorRef: 'slack:actor:U2',
  }));
  assert.equal(reacted.result.state, 'PENDING_PARENT');
  assert.equal(reacted.state.pendingEvents[0].reason, 'REACTION_PARENT_MESSAGE_NOT_INGESTED');
});

test('known-message reaction is recorded as non-authoritative social state', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const reacted = processInboundEvent(first.state, messageEvent({
    eventId: 'EvReaction',
    type: 'REACTION_ADDED',
    body: '',
    reaction: 'white_check_mark',
    reactionActorRef: 'slack:actor:U2',
  }), { now: '2026-09-02T16:00:02Z' });
  assert.equal(reacted.result.state, 'REACTION_RECORDED');
  assert.equal(reacted.state.messaging.reactions[0].meaning, 'ACKNOWLEDGED');
  assert.equal(reacted.state.messaging.reactions[0].grantsAuthority, false);
});

test('reaction removal marks known reaction removed', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const added = processInboundEvent(first.state, messageEvent({
    eventId: 'EvReactionAdd',
    type: 'REACTION_ADDED',
    body: '',
    reaction: 'eyes',
    reactionActorRef: 'slack:actor:U2',
  }), { now: '2026-09-02T16:00:02Z' });
  const removed = processInboundEvent(added.state, messageEvent({
    eventId: 'EvReactionRemove',
    type: 'REACTION_REMOVED',
    body: '',
    reaction: 'eyes',
    reactionActorRef: 'slack:actor:U2',
  }), { now: '2026-09-02T16:00:03Z' });
  assert.equal(removed.result.state, 'REACTION_REMOVED');
  assert.equal(removed.state.messaging.reactions[0].state, 'REMOVED');
});

test('thread resolution before thread ingestion remains pending', () => {
  const result = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent({
    eventId: 'EvResolveFirst',
    type: 'THREAD_RESOLVED',
    providerMessageRef: null,
    body: '',
  }));
  assert.equal(result.result.state, 'PENDING_PARENT');
  assert.equal(result.state.pendingEvents[0].reason, 'THREAD_NOT_INGESTED');
});

test('authoritative provider resolution updates known thread', () => {
  const first = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const resolved = processInboundEvent(first.state, messageEvent({
    eventId: 'EvResolve',
    type: 'THREAD_RESOLVED',
    providerMessageRef: null,
    body: '',
  }), { now: '2026-09-02T16:00:02Z' });
  assert.equal(resolved.result.state, 'THREAD_RESOLVED');
  assert.equal(resolved.state.messaging.threads[0].state, 'RESOLVED');
});

test('pipeline public status contains aggregate evidence only', () => {
  const result = processInboundEvent(createEmptyMessagingPipelineState(), messageEvent(), { now: '2026-09-02T16:00:01Z' });
  const status = pipelinePublicStatus(result.state);
  assert.equal(status.inboundEvents, 1);
  assert.equal(status.messages, 1);
  assert.equal(status.rawBodiesPersisted, false);
  assert.equal(status.secretValuesPersisted, false);
  assert.equal(Object.hasOwn(status, 'threadResource'), false);
  assert.equal(Object.hasOwn(status, 'bodyRef'), false);
});
