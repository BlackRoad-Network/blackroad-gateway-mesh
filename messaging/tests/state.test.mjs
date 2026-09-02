import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyMessagingState,
  createMirrorProjection,
  ingestProviderMessage,
  publicMessagingStatus,
  recordProjectionOutcome,
  recordReaction,
  setThreadState,
  verifyEventChain,
} from '../state.mjs';

function slackMessage(overrides = {}) {
  return {
    providerId: 'slack',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    providerMessageRef: '1234567890.654321',
    authorRef: 'slack:user:U1',
    body: 'hello',
    providerVersionRef: 'v1',
    createdAt: '2026-09-02T16:00:00.000Z',
    ...overrides,
  };
}

test('creates an empty durable messaging state', () => {
  const state = createEmptyMessagingState();
  assert.equal(state.revision, 0);
  assert.deepEqual(state.threads, []);
  assert.deepEqual(state.messages, []);
});

test('ingesting a provider message creates one authoritative thread and reference-only message', () => {
  const result = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  assert.equal(result.state.threads.length, 1);
  assert.equal(result.state.messages.length, 1);
  assert.equal(result.thread.authority.providerId, 'slack');
  assert.equal(Object.hasOwn(result.message, 'body'), false);
  assert.equal(result.message.bodyLength, 5);
  assert.equal(verifyEventChain(result.state).ok, true);
});

test('identical provider delivery replays without duplicate message', () => {
  const first = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const second = ingestProviderMessage(first.state, slackMessage(), { now: '2026-09-02T16:00:02Z' });
  assert.equal(second.replay, true);
  assert.equal(second.state.messages.length, 1);
  assert.equal(second.state.events.length, first.state.events.length);
});

test('provider-native edit records prior hash as a revision', () => {
  const first = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const second = ingestProviderMessage(first.state, slackMessage({
    body: 'hello edited',
    providerVersionRef: 'v2',
    updatedAt: '2026-09-02T16:01:00.000Z',
  }), { now: '2026-09-02T16:01:01Z' });
  assert.equal(second.updated, true);
  assert.equal(second.message.revisions.length, 1);
  assert.notEqual(second.message.bodyHash, second.message.revisions[0].bodyHash);
  assert.equal(Object.hasOwn(second.message, 'body'), false);
});

test('same provider message cannot silently move to another thread', () => {
  const first = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  assert.throws(
    () => ingestProviderMessage(first.state, slackMessage({
      target: { teamId: 'T1', channelId: 'C2', threadTs: '9999999999.000001' },
    }), { now: '2026-09-02T16:00:02Z' }),
    (error) => error.code === 'MESSAGE_THREAD_CONFLICT',
  );
});

test('reaction records acknowledgement without granting authority', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const reacted = recordReaction(ingested.state, {
    messageId: ingested.message.id,
    actorRef: 'slack:user:U2',
    emoji: 'white_check_mark',
  }, { now: '2026-09-02T16:00:02Z' });
  assert.equal(reacted.reaction.meaning, 'ACKNOWLEDGED');
  assert.equal(reacted.reaction.grantsAuthority, false);
  assert.equal(reacted.reaction.satisfiesGovernance, false);
  assert.equal(reacted.reaction.satisfiesUserApproval, false);
});

test('duplicate reaction is replayed rather than multiplied', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const first = recordReaction(ingested.state, {
    messageId: ingested.message.id,
    actorRef: 'slack:user:U2',
    emoji: 'eyes',
  }, { now: '2026-09-02T16:00:02Z' });
  const second = recordReaction(first.state, {
    messageId: ingested.message.id,
    actorRef: 'slack:user:U2',
    emoji: 'eyes',
  }, { now: '2026-09-02T16:00:03Z' });
  assert.equal(second.replay, true);
  assert.equal(second.state.reactions.length, 1);
});

test('non-authoritative provider cannot resolve a thread', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  assert.throws(
    () => setThreadState(ingested.state, {
      threadId: ingested.thread.id,
      providerId: 'github',
      state: 'RESOLVED',
    }),
    (error) => error.code === 'THREAD_AUTHORITY_REQUIRED',
  );
});

test('authoritative provider can resolve a thread with evidence', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const resolved = setThreadState(ingested.state, {
    threadId: ingested.thread.id,
    providerId: 'slack',
    state: 'RESOLVED',
    evidenceRef: 'slack:thread:readback',
  }, { now: '2026-09-02T16:00:02Z' });
  assert.equal(resolved.thread.state, 'RESOLVED');
  assert.equal(verifyEventChain(resolved.state).ok, true);
});

test('verified source can create one-way Slack projection', () => {
  const created = createMirrorProjection(createEmptyMessagingState(), {
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', kind: 'pr', number: 1 },
    destinationTarget: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    providerMessageRef: 'github-comment-1',
    sourceState: 'VERIFIED',
    userApprovalRef: 'approval:1',
    body: 'projection',
  }, { now: '2026-09-02T16:00:01Z' });
  assert.equal(created.created, true);
  assert.equal(created.projection.direction, 'OUTBOUND_PROJECTION');
  assert.equal(created.projection.bidirectional, false);
});

test('blocked mirror does not create projection state', () => {
  const blocked = createMirrorProjection(createEmptyMessagingState(), {
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', kind: 'pr', number: 1 },
    destinationTarget: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    sourceState: 'SUCCEEDED_UNVERIFIED',
    userApprovalRef: 'approval:1',
    body: 'projection',
  });
  assert.equal(blocked.created, false);
  assert.equal(blocked.projection, null);
  assert.equal(blocked.state.projections.length, 0);
});

test('projection timeout remains unknown', () => {
  const created = createMirrorProjection(createEmptyMessagingState(), {
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', kind: 'pr', number: 1 },
    destinationTarget: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    sourceState: 'VERIFIED',
    userApprovalRef: 'approval:1',
    body: 'projection',
  }, { now: '2026-09-02T16:00:01Z' });
  const finished = recordProjectionOutcome(created.state, {
    projectionId: created.projection.id,
    kind: 'timeout',
    providerRequestRef: 'slack:request:unknown',
  }, { now: '2026-09-02T16:00:02Z' });
  assert.equal(finished.projection.state, 'TIMEOUT_UNKNOWN');
  assert.equal(finished.outcome.retryAllowed, false);
});

test('public status exposes counts and chain health, not provider targets', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const status = publicMessagingStatus(ingested.state);
  assert.equal(status.threads, 1);
  assert.equal(status.messages, 1);
  assert.equal(status.eventChain.ok, true);
  assert.equal(Object.hasOwn(status, 'resourceKey'), false);
  assert.equal(Object.hasOwn(status, 'messagesByRef'), false);
});

test('event-chain tampering is detected', () => {
  const ingested = ingestProviderMessage(createEmptyMessagingState(), slackMessage(), { now: '2026-09-02T16:00:01Z' });
  const tampered = structuredClone(ingested.state);
  tampered.events[0].summary = 'rewritten history';
  assert.equal(verifyEventChain(tampered).ok, false);
  assert.equal(verifyEventChain(tampered).reason, 'EVENT_HASH_MISMATCH');
});
