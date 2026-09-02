import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessagingWebhookServer } from '../webhook-server.mjs';
import { createEmptyMessagingPipelineState } from '../pipeline.mjs';
import { registerSubscription } from '../router.mjs';
import { readPipelineState, writePipelineState } from '../store.mjs';

const now = '2026-09-02T16:00:00.000Z';
const nowSeconds = Math.floor(new Date(now).getTime() / 1000);
const slackSecret = 'slack-server-signing-secret';
const githubSecret = 'github-server-webhook-secret';

function slackPayload(overrides = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'EvServer1',
    event: {
      type: 'message',
      user: 'U1',
      text: 'hello',
      channel: 'C1',
      ts: '1788364800.123456',
      event_ts: '1788364800.123456',
    },
    ...overrides,
  };
}

function slackHeaders(body, timestamp = nowSeconds, secret = slackSecret) {
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
  };
}

function githubHeaders(body, secret = githubSecret) {
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    'x-github-delivery': 'delivery-server-1',
    'x-github-event': 'issue_comment',
  };
}

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'blackroad-messaging-server-'));
}

async function startServer(t, options = {}) {
  const root = options.stateRoot || await temporaryRoot();
  const service = createMessagingWebhookServer({
    host: '127.0.0.1',
    port: 0,
    stateRoot: root,
    now: () => new Date(now),
    secretResolver: async (providerId) => {
      if (providerId === 'slack') return slackSecret;
      if (providerId === 'github') return githubSecret;
      return null;
    },
    identityMapResolver: options.identityMapResolver,
    bodyLimitBytes: options.bodyLimitBytes,
  });
  const address = await service.start();
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { service, root, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('server refuses non-loopback bind without explicit authorization', () => {
  assert.throws(
    () => createMessagingWebhookServer({ host: '0.0.0.0', port: 0, stateRoot: '/tmp/unused' }),
    (error) => error.code === 'NON_LOOPBACK_BIND_DENIED',
  );
});

test('health reports local-only ingress with provider execution disabled', async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'READY_LOCAL');
  assert.equal(body.bindScope, 'loopback');
  assert.equal(body.providerExecution, false);
  assert.equal(body.publicIngress, false);
});

test('invalid Slack signature is rejected before state mutation', async (t) => {
  const { baseUrl, root } = await startServer(t);
  const body = JSON.stringify(slackPayload());
  const response = await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body, nowSeconds, 'wrong-secret'),
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 401);
  assert.equal(payload.accepted, false);
  assert.equal(payload.error.code, 'WEBHOOK_SIGNATURE_INVALID');
  assert.equal((await readPipelineState(root)).inboundEvents.length, 0);
});

test('verified Slack URL challenge is returned transiently and stored only by reference', async (t) => {
  const { baseUrl, root } = await startServer(t);
  const body = JSON.stringify({ type: 'url_verification', challenge: 'transient-challenge' });
  const response = await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.challenge, 'transient-challenge');
  const state = await readPipelineState(root);
  assert.equal(state.inboundEvents.length, 1);
  assert.equal(Object.hasOwn(state.inboundEvents[0], 'challenge'), false);
  assert.match(state.inboundEvents[0].challengeRef, /^slack:challenge:/);
});

test('verified Slack message persists metadata without raw body', async (t) => {
  const { baseUrl, root } = await startServer(t);
  const body = JSON.stringify(slackPayload());
  const response = await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.accepted, true);
  assert.equal(payload.eventType, 'MESSAGE_CREATED');
  assert.equal(payload.rawBodyPersisted, false);
  assert.equal(payload.bodyPersisted, false);
  const state = await readPipelineState(root);
  assert.equal(state.inboundEvents.length, 1);
  assert.equal(state.messaging.messages.length, 1);
  assert.equal(Object.hasOwn(state.inboundEvents[0], 'body'), false);
  assert.equal(Object.hasOwn(state.messaging.messages[0], 'body'), false);
});

test('duplicate Slack delivery is replayed without duplicate message', async (t) => {
  const { baseUrl, root } = await startServer(t);
  const body = JSON.stringify(slackPayload());
  const request = () => fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  await request();
  const second = await request();
  const payload = await second.json();
  assert.equal(payload.replay, true);
  const state = await readPipelineState(root);
  assert.equal(state.inboundEvents.length, 1);
  assert.equal(state.messaging.messages.length, 1);
});

test('verified GitHub comment enters the same durable pipeline', async (t) => {
  const { baseUrl, root } = await startServer(t);
  const body = JSON.stringify({
    action: 'created',
    repository: { full_name: 'BlackRoad-Network/Gateway' },
    issue: { number: 4, pull_request: { url: 'https://example.invalid/pr/4' } },
    comment: {
      id: 123,
      body: 'review comment',
      user: { login: 'reviewer' },
      created_at: now,
      updated_at: now,
    },
  });
  const response = await fetch(`${baseUrl}/webhooks/github`, {
    method: 'POST',
    headers: githubHeaders(body),
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.providerId, 'github');
  assert.equal(payload.eventType, 'MESSAGE_CREATED');
  const state = await readPipelineState(root);
  assert.equal(state.messaging.messages[0].providerId, 'github');
});

test('verified mention routes to agent inbox and handoff outbox', async (t) => {
  const root = await temporaryRoot();
  const state = createEmptyMessagingPipelineState();
  const subscribed = registerSubscription(state.router, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['slack'],
    mentionRefs: ['road://agent/agent-instance-4'],
    deliveryMode: 'HANDOFF',
  });
  state.router = subscribed.state;
  await writePipelineState(root, state);

  const { baseUrl } = await startServer(t, {
    stateRoot: root,
    identityMapResolver: async () => ({
      identities: [{
        ref: 'road://agent/agent-instance-4',
        providers: { slack: { kind: 'user', id: 'U4' } },
      }],
    }),
  });
  const payload = slackPayload({
    event_id: 'EvMentionServer',
    event: {
      type: 'app_mention',
      user: 'U1',
      text: '<@U4> please review',
      channel: 'C1',
      ts: '1788364800.223456',
      event_ts: '1788364800.223456',
    },
  });
  const body = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  const result = await response.json();
  assert.equal(result.inboxDeliveries, 1);
  assert.equal(result.handoffOutboxCreated, 1);
  const restored = await readPipelineState(root);
  assert.equal(restored.router.inbox[0].state, 'ACTION_REQUIRED');
  assert.equal(restored.handoffOutbox[0].state, 'PENDING');
});

test('status exposes aggregate counts but no private provider targets', async (t) => {
  const { baseUrl } = await startServer(t);
  const body = JSON.stringify(slackPayload());
  await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  const response = await fetch(`${baseUrl}/status`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.messaging.inboundEvents, 1);
  assert.equal(payload.messaging.rawBodiesPersisted, false);
  assert.equal(payload.outbox.privatePlansExposed, false);
  assert.equal(Object.hasOwn(payload, 'threadResource'), false);
});

test('oversized webhook body is rejected before parsing', async (t) => {
  const { baseUrl } = await startServer(t, { bodyLimitBytes: 1024 });
  const body = JSON.stringify({ value: 'x'.repeat(2048) });
  const response = await fetch(`${baseUrl}/webhooks/slack`, {
    method: 'POST',
    headers: slackHeaders(body),
    body,
  });
  const payload = await response.json();
  assert.equal(response.status, 413);
  assert.equal(payload.error.code, 'WEBHOOK_BODY_TOO_LARGE');
});
