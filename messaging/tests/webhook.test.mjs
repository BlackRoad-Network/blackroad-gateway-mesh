import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  durableInboundEvent,
  inboundDedupeKey,
  normalizeVerifiedWebhook,
} from '../inbound.mjs';
import {
  verifyAdapterAttestation,
  verifyGitHubWebhook,
  verifySlackWebhook,
} from '../webhook-verification.mjs';

const slackSecret = 'slack-test-signing-secret';
const githubSecret = 'github-test-webhook-secret';
const now = '2026-09-02T16:00:00.000Z';
const nowSeconds = Math.floor(new Date(now).getTime() / 1000);

function slackHeaders(body, timestamp = nowSeconds, secret = slackSecret) {
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': signature,
    'x-slack-request-id': 'slack-request-1',
  };
}

function githubHeaders(body, eventName = 'issue_comment', secret = githubSecret) {
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return {
    'x-hub-signature-256': signature,
    'x-github-delivery': 'delivery-1',
    'x-github-event': eventName,
  };
}

function slackMessagePayload(overrides = {}) {
  return {
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event: {
      type: 'message',
      user: 'U1',
      text: '<@U2> hello',
      channel: 'C1',
      ts: '1788364800.123456',
      event_ts: '1788364800.123456',
    },
    ...overrides,
  };
}

function githubIssuePayload(overrides = {}) {
  return {
    action: 'created',
    repository: { full_name: 'BlackRoad-Network/Gateway' },
    issue: { number: 4, pull_request: { url: 'https://example.invalid/pr/4' } },
    comment: {
      id: 123,
      body: '@blackboxprogramming hello',
      user: { login: 'octocat' },
      created_at: '2026-09-02T16:00:00Z',
      updated_at: '2026-09-02T16:00:00Z',
    },
    sender: { login: 'octocat' },
    ...overrides,
  };
}

test('verifies a valid Slack signature without persisting the signing secret', () => {
  const body = JSON.stringify(slackMessagePayload());
  const result = verifySlackWebhook({ rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(result.verified, true);
  assert.equal(result.providerId, 'slack');
  assert.equal(result.secretPersisted, false);
  assert.equal(Object.hasOwn(result, 'signingSecret'), false);
});

test('rejects an invalid Slack signature', () => {
  const body = JSON.stringify(slackMessagePayload());
  assert.throws(
    () => verifySlackWebhook({ rawBody: body, headers: slackHeaders(body, nowSeconds, 'wrong-secret'), signingSecret: slackSecret, now }),
    (error) => error.code === 'WEBHOOK_SIGNATURE_INVALID',
  );
});

test('rejects a stale Slack request outside replay window', () => {
  const body = JSON.stringify(slackMessagePayload());
  const stale = nowSeconds - 301;
  assert.throws(
    () => verifySlackWebhook({ rawBody: body, headers: slackHeaders(body, stale), signingSecret: slackSecret, now }),
    (error) => error.code === 'WEBHOOK_REPLAY_WINDOW_EXCEEDED',
  );
});

test('verifies a valid GitHub webhook signature and delivery identity', () => {
  const body = JSON.stringify(githubIssuePayload());
  const result = verifyGitHubWebhook({ rawBody: body, headers: githubHeaders(body), signingSecret: githubSecret });
  assert.equal(result.verified, true);
  assert.equal(result.deliveryRef, 'delivery-1');
  assert.equal(result.eventName, 'issue_comment');
  assert.equal(result.secretPersisted, false);
});

test('rejects an invalid GitHub webhook signature', () => {
  const body = JSON.stringify(githubIssuePayload());
  assert.throws(
    () => verifyGitHubWebhook({ rawBody: body, headers: githubHeaders(body, 'issue_comment', 'wrong-secret'), signingSecret: githubSecret }),
    (error) => error.code === 'WEBHOOK_SIGNATURE_INVALID',
  );
});

test('adapter providers require a verified attestation', () => {
  assert.throws(
    () => verifyAdapterAttestation({ providerId: 'microsoft-teams', adapterAttestation: { verified: false } }),
    (error) => error.code === 'ADAPTER_VERIFICATION_REQUIRED',
  );
});

test('adapter attestation cannot be reused for another provider', () => {
  assert.throws(
    () => verifyAdapterAttestation({
      providerId: 'microsoft-teams',
      adapterAttestation: { verified: true, providerId: 'discord', verificationRef: 'adapter:verified:1' },
    }),
    (error) => error.code === 'ADAPTER_PROVIDER_MISMATCH',
  );
});

test('normalizes a signed Slack message into canonical thread identity', () => {
  const payload = slackMessagePayload();
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(event.type, 'MESSAGE_CREATED');
  assert.match(event.threadResource, /^road\+message:\/\/slack\/team\/T1\/channel\/C1\/thread\//);
  assert.equal(event.providerMessageRef, '1788364800.123456');
  assert.deepEqual(event.providerMentionIds, ['U2']);
  assert.equal(event.bodyPersisted, false);
});

test('normalizes a signed Slack edit as MESSAGE_UPDATED', () => {
  const payload = slackMessagePayload({
    event_id: 'Ev2',
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      event_ts: '1788364801.000001',
      message: {
        type: 'message',
        user: 'U1',
        text: 'edited',
        channel: 'C1',
        ts: '1788364800.123456',
        thread_ts: '1788364800.123456',
        edited: { user: 'U1', ts: '1788364801.000001' },
      },
    },
  });
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(event.type, 'MESSAGE_UPDATED');
  assert.equal(event.providerVersionRef, '1788364801.000001');
  assert.equal(event.body, 'edited');
});

test('normalizes a signed Slack delete without persisting prior body', () => {
  const payload = slackMessagePayload({
    event_id: 'Ev3',
    event: {
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C1',
      deleted_ts: '1788364800.123456',
      event_ts: '1788364802.000001',
      previous_message: {
        type: 'message',
        text: 'deleted content',
        user: 'U1',
        ts: '1788364800.123456',
      },
    },
  });
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(event.type, 'MESSAGE_DELETED');
  assert.equal(event.body, '');
  assert.equal(event.bodyLength, 0);
});

test('normalizes a signed Slack reaction event', () => {
  const payload = slackMessagePayload({
    event_id: 'Ev4',
    event: {
      type: 'reaction_added',
      user: 'U2',
      reaction: 'eyes',
      item_user: 'U1',
      item: { type: 'message', channel: 'C1', ts: '1788364800.123456' },
      event_ts: '1788364803.000001',
    },
  });
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(event.type, 'REACTION_ADDED');
  assert.equal(event.reaction, 'eyes');
  assert.equal(event.reactionActorRef, 'slack:actor:U2');
});

test('normalizes Slack URL verification without retaining challenge value', () => {
  const payload = { type: 'url_verification', challenge: 'challenge-value' };
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  assert.equal(event.type, 'HANDSHAKE');
  assert.match(event.challengeRef, /^slack:challenge:/);
  assert.equal(Object.hasOwn(event, 'challenge'), false);
});

test('normalizes a signed GitHub PR comment', () => {
  const payload = githubIssuePayload();
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'github', rawBody: body, headers: githubHeaders(body), signingSecret: githubSecret });
  assert.equal(event.type, 'MESSAGE_CREATED');
  assert.equal(event.target.kind, 'pr');
  assert.equal(event.target.owner, 'BlackRoad-Network');
  assert.equal(event.target.repo, 'Gateway');
  assert.deepEqual(event.providerMentionIds, ['blackboxprogramming']);
  assert.match(event.threadResource, /blackroad-network\/gateway\/pr\/4$/);
});

test('normalizes a signed GitHub review reply', () => {
  const payload = {
    action: 'created',
    repository: { full_name: 'BlackRoad-Network/Gateway' },
    pull_request: { number: 4 },
    comment: {
      id: 555,
      in_reply_to_id: 444,
      body: 'inline reply',
      user: { login: 'reviewer' },
      created_at: '2026-09-02T16:00:00Z',
      updated_at: '2026-09-02T16:00:00Z',
    },
  };
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'github', rawBody: body, headers: githubHeaders(body, 'pull_request_review_comment'), signingSecret: githubSecret });
  assert.equal(event.type, 'MESSAGE_CREATED');
  assert.equal(event.parentProviderMessageRef, '444');
  assert.equal(event.providerMessageRef, '555');
});

test('unknown signed GitHub event remains UNSUPPORTED_EVENT', () => {
  const payload = { action: 'opened', repository: { full_name: 'o/r' } };
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'github', rawBody: body, headers: githubHeaders(body, 'pull_request'), signingSecret: githubSecret });
  assert.equal(event.type, 'UNSUPPORTED_EVENT');
  assert.equal(event.providerEventType, 'pull_request');
});

test('normalizes an adapter-attested Teams message without claiming direct signature verification', () => {
  const payload = {
    eventId: 'teams-event-1',
    type: 'MESSAGE_CREATED',
    target: { scope: 'tenant-a', threadId: 'thread-1' },
    providerMessageRef: 'message-1',
    authorRef: 'teams:actor:user-1',
    body: 'hello from Teams',
  };
  const event = normalizeVerifiedWebhook({
    providerId: 'microsoft-teams',
    payload,
    adapterAttestation: {
      verified: true,
      providerId: 'microsoft-teams',
      verificationRef: 'teams-adapter:activity:verified:1',
      deliveryRef: 'activity-1',
    },
  });
  assert.equal(event.type, 'MESSAGE_CREATED');
  assert.equal(event.verification.verificationMode, 'chat-sdk-adapter-attested');
  assert.match(event.threadResource, /^road\+message:\/\/microsoft-teams\/scope\/tenant-a\/thread\/thread-1$/);
});

test('durable event strips transient body while preserving hash and evidence', () => {
  const payload = slackMessagePayload();
  const body = JSON.stringify(payload);
  const event = normalizeVerifiedWebhook({ providerId: 'slack', rawBody: body, headers: slackHeaders(body), signingSecret: slackSecret, now });
  const durable = durableInboundEvent(event);
  assert.equal(Object.hasOwn(durable, 'body'), false);
  assert.equal(durable.bodyHash, event.bodyHash);
  assert.equal(durable.verification.verificationRef, event.verification.verificationRef);
  assert.equal(durable.verification.secretPersisted, false);
});

test('inbound dedupe identity changes for a provider-native revision', () => {
  const first = {
    providerId: 'github',
    eventId: 'delivery-1',
    type: 'MESSAGE_UPDATED',
    providerMessageRef: '123',
    providerVersionRef: 'v1',
  };
  const second = { ...first, providerVersionRef: 'v2' };
  assert.notEqual(inboundDedupeKey(first), inboundDedupeKey(second));
});
