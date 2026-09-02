import { createHmac, timingSafeEqual } from 'node:crypto';
import { MessagingError, sha256 } from './framework.mjs';

export const WEBHOOK_VERIFICATION_PROFILES = Object.freeze({
  slack: {
    mode: 'hmac-sha256-v0',
    signatureHeader: 'x-slack-signature',
    timestampHeader: 'x-slack-request-timestamp',
    replayWindowSeconds: 300,
  },
  github: {
    mode: 'hmac-sha256',
    signatureHeader: 'x-hub-signature-256',
    deliveryHeader: 'x-github-delivery',
    eventHeader: 'x-github-event',
  },
  linear: { mode: 'adapter-attested' },
  asana: { mode: 'adapter-attested' },
  notion: { mode: 'adapter-attested' },
  airtable: { mode: 'adapter-attested' },
  'microsoft-teams': { mode: 'chat-sdk-adapter-attested' },
  'google-chat': { mode: 'chat-sdk-adapter-attested' },
  discord: { mode: 'chat-sdk-adapter-attested' },
  telegram: { mode: 'chat-sdk-adapter-attested' },
  whatsapp: { mode: 'chat-sdk-adapter-attested' },
  matrix: { mode: 'chat-sdk-adapter-attested' },
});

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function requireSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 8) {
    throw new MessagingError('SIGNING_SECRET_REQUIRED', 'A transient provider signing secret is required for verification');
  }
  return secret;
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function verificationRef(providerId, signature, deliveryRef = null) {
  return `road://verification/${providerId}/${sha256(`${signature}:${deliveryRef || ''}`).slice(0, 32)}`;
}

export function verifySlackWebhook(input) {
  const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString('utf8') : String(input.rawBody ?? '');
  const timestampRaw = header(input.headers, 'x-slack-request-timestamp');
  const signature = header(input.headers, 'x-slack-signature');
  if (!timestampRaw || !signature) {
    throw new MessagingError('WEBHOOK_SIGNATURE_HEADERS_REQUIRED', 'Slack timestamp and signature headers are required');
  }

  const timestamp = Number.parseInt(String(timestampRaw), 10);
  if (!Number.isFinite(timestamp)) throw new MessagingError('INVALID_WEBHOOK_TIMESTAMP', 'Slack request timestamp is invalid');
  const nowSeconds = Math.floor(new Date(input.now || new Date()).getTime() / 1000);
  const maximumSkew = Number.isFinite(input.maximumSkewSeconds) ? input.maximumSkewSeconds : 300;
  if (Math.abs(nowSeconds - timestamp) > maximumSkew) {
    throw new MessagingError('WEBHOOK_REPLAY_WINDOW_EXCEEDED', 'Slack request timestamp is outside the accepted replay window');
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac('sha256', requireSecret(input.signingSecret)).update(base).digest('hex');
  const expected = `v0=${digest}`;
  if (!safeEqual(signature, expected)) throw new MessagingError('WEBHOOK_SIGNATURE_INVALID', 'Slack request signature did not match');

  return {
    providerId: 'slack',
    verified: true,
    verificationMode: WEBHOOK_VERIFICATION_PROFILES.slack.mode,
    verificationRef: verificationRef('slack', signature, String(timestamp)),
    timestamp: new Date(timestamp * 1000).toISOString(),
    deliveryRef: header(input.headers, 'x-slack-request-id') || null,
    rawBodyHash: sha256(rawBody),
    secretPersisted: false,
  };
}

export function verifyGitHubWebhook(input) {
  const rawBody = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.from(String(input.rawBody ?? ''), 'utf8');
  const signature = header(input.headers, 'x-hub-signature-256');
  const deliveryRef = header(input.headers, 'x-github-delivery');
  const eventName = header(input.headers, 'x-github-event');
  if (!signature || !deliveryRef || !eventName) {
    throw new MessagingError('WEBHOOK_SIGNATURE_HEADERS_REQUIRED', 'GitHub signature, delivery, and event headers are required');
  }

  const digest = createHmac('sha256', requireSecret(input.signingSecret)).update(rawBody).digest('hex');
  const expected = `sha256=${digest}`;
  if (!safeEqual(signature, expected)) throw new MessagingError('WEBHOOK_SIGNATURE_INVALID', 'GitHub webhook signature did not match');

  return {
    providerId: 'github',
    verified: true,
    verificationMode: WEBHOOK_VERIFICATION_PROFILES.github.mode,
    verificationRef: verificationRef('github', signature, deliveryRef),
    timestamp: null,
    deliveryRef: String(deliveryRef),
    eventName: String(eventName),
    rawBodyHash: sha256(rawBody),
    secretPersisted: false,
  };
}

export function verifyAdapterAttestation(input) {
  const providerId = String(input.providerId || '').toLowerCase();
  const profile = WEBHOOK_VERIFICATION_PROFILES[providerId];
  if (!profile) throw new MessagingError('UNKNOWN_WEBHOOK_PROVIDER', `No webhook verification profile exists for ${providerId}`);
  const attestation = input.adapterAttestation;
  if (!attestation || attestation.verified !== true || !attestation.verificationRef) {
    throw new MessagingError('ADAPTER_VERIFICATION_REQUIRED', `${providerId} requires a verified adapter attestation`);
  }
  if (attestation.providerId && String(attestation.providerId).toLowerCase() !== providerId) {
    throw new MessagingError('ADAPTER_PROVIDER_MISMATCH', 'Adapter attestation belongs to another provider');
  }
  return {
    providerId,
    verified: true,
    verificationMode: profile.mode,
    verificationRef: String(attestation.verificationRef),
    timestamp: attestation.timestamp || null,
    deliveryRef: attestation.deliveryRef || null,
    eventName: attestation.eventName || null,
    rawBodyHash: input.rawBody === undefined ? null : sha256(Buffer.isBuffer(input.rawBody) ? input.rawBody : String(input.rawBody)),
    secretPersisted: false,
  };
}

export function verifyInboundWebhook(input) {
  const providerId = String(input.providerId || '').toLowerCase();
  if (providerId === 'slack') return verifySlackWebhook(input);
  if (providerId === 'github') return verifyGitHubWebhook(input);
  return verifyAdapterAttestation({ ...input, providerId });
}
