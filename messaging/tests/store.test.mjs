import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireMessagingLock,
  appendReferenceReceipt,
  ingestInboundTransaction,
  initializeMessagingStore,
  readPipelineState,
  resolveMessagingStateRoot,
  storePaths,
  withMessagingTransaction,
  writePipelineState,
} from '../store.mjs';
import { createEmptyMessagingPipelineState } from '../pipeline.mjs';
import { registerSubscription } from '../router.mjs';

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'blackroad-messaging-store-'));
}

function verifiedEvent() {
  return {
    schema: 'road-messaging-inbound-event-v1',
    eventId: 'EvStore1',
    providerId: 'github',
    type: 'MENTION_RECEIVED',
    target: { owner: 'BlackRoad-Network', repo: 'gateway', kind: 'pr', number: 4 },
    threadResource: 'road+message://github/repository/blackroad-network/gateway/pr/4',
    providerMessageRef: 'comment-1',
    parentProviderMessageRef: null,
    authorRef: 'github:actor:reviewer',
    providerMentionIds: ['blackboxprogramming'],
    body: '@blackboxprogramming review this',
    bodyRef: 'github:comment:comment-1/content',
    bodyHash: 'unused',
    bodyLength: 36,
    providerVersionRef: 'v1',
    createdAt: '2026-09-02T16:00:00Z',
    verification: {
      providerId: 'github',
      verified: true,
      verificationMode: 'hmac-sha256',
      verificationRef: 'road://verification/github/1',
      rawBodyHash: 'a'.repeat(64),
      secretPersisted: false,
    },
    rawBodyPersisted: false,
    bodyPersisted: false,
  };
}

const identityMap = {
  identities: [
    {
      ref: 'road://agent/agent-instance-4',
      providers: { github: { kind: 'user', handle: 'blackboxprogramming' } },
    },
  ],
};

test('resolves canonical workspace state root', () => {
  assert.equal(
    resolveMessagingStateRoot({ env: { ROAD_WORKSPACE_ROOT: '/tmp/road-workspace' } }),
    '/tmp/road-workspace/.road-agents/shared/messaging',
  );
});

test('initializes an empty private state file', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeMessagingStore(root);
  const state = await readPipelineState(root);
  assert.equal(state.schema, 'road-messaging-pipeline-state-v1');
  assert.equal(state.inboundEvents.length, 0);
  const mode = (await stat(storePaths(root).state)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('atomic write preserves complete parseable state', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createEmptyMessagingPipelineState();
  state.revision = 7;
  await writePipelineState(root, state);
  const restored = await readPipelineState(root);
  assert.equal(restored.revision, 7);
});

test('state writer rejects secret-bearing serialization', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createEmptyMessagingPipelineState();
  state.accidental = 'Bearer abcdefghijklmnopqrstuvwxyz';
  await assert.rejects(
    () => writePipelineState(root, state),
    (error) => error.code === 'SECRET_MATERIAL_REJECTED',
  );
});

test('exclusive lock rejects a second concurrent transaction', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireMessagingLock(root, {
    agentId: 'connector-orchestrator',
    sessionRef: 'session-a',
    timeoutMs: 100,
  });
  t.after(() => first.release().catch(() => {}));
  await assert.rejects(
    () => acquireMessagingLock(root, {
      agentId: 'agent-instance-4',
      sessionRef: 'session-b',
      timeoutMs: 60,
      retryMs: 10,
    }),
    (error) => error.code === 'STATE_LOCK_TIMEOUT',
  );
});

test('transaction reads, transforms, and atomically commits state', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeMessagingStore(root);
  const result = await withMessagingTransaction(root, async (state) => {
    state.revision = 11;
    return { state, marker: 'committed' };
  }, { agentId: 'connector-orchestrator', sessionRef: 'session-a' });
  assert.equal(result.marker, 'committed');
  assert.equal((await readPipelineState(root)).revision, 11);
});

test('verified ingress transaction routes inbox and enqueues one broker handoff', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createEmptyMessagingPipelineState();
  const subscribed = registerSubscription(state.router, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['github'],
    mentionRefs: ['road://agent/agent-instance-4'],
    deliveryMode: 'HANDOFF',
  });
  state.router = subscribed.state;
  await writePipelineState(root, state);

  const result = await ingestInboundTransaction(root, verifiedEvent(), {
    identityMap,
    sourceAgentId: 'connector-orchestrator',
    agentId: 'connector-orchestrator',
    sessionRef: 'ingress-session',
    now: '2026-09-02T16:00:01Z',
  });

  assert.equal(result.inboxItems.length, 1);
  assert.equal(result.outboxCreated.length, 1);
  const restored = await readPipelineState(root);
  assert.equal(restored.inboundEvents.length, 1);
  assert.equal(restored.router.inbox.length, 1);
  assert.equal(restored.handoffOutbox.length, 1);
  assert.equal(Object.hasOwn(restored.messaging.messages[0], 'body'), false);
});

test('replayed ingress does not duplicate outbox work', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = createEmptyMessagingPipelineState();
  const subscribed = registerSubscription(state.router, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['github'],
    deliveryMode: 'HANDOFF',
  });
  state.router = subscribed.state;
  await writePipelineState(root, state);

  await ingestInboundTransaction(root, verifiedEvent(), {
    identityMap,
    agentId: 'connector-orchestrator',
    sessionRef: 'ingress-session',
  });
  const replay = await ingestInboundTransaction(root, verifiedEvent(), {
    identityMap,
    agentId: 'connector-orchestrator',
    sessionRef: 'ingress-session',
  });
  assert.equal(replay.replay, true);
  const restored = await readPipelineState(root);
  assert.equal(restored.handoffOutbox.length, 1);
});

test('reference receipt append is private and body-free', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await appendReferenceReceipt(root, {
    schema: 'road-messaging-ingress-receipt-v1',
    providerId: 'github',
    eventId: 'delivery-1',
    verificationRef: 'road://verification/github/1',
    bodyPersisted: false,
    secretValuesPersisted: false,
  });
  const text = await readFile(storePaths(root).receipts, 'utf8');
  const receipt = JSON.parse(text.trim());
  assert.equal(receipt.bodyPersisted, false);
  assert.equal(receipt.secretValuesPersisted, false);
  const mode = (await stat(storePaths(root).receipts)).mode & 0o777;
  assert.equal(mode, 0o600);
});
