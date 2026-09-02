import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROVIDER_DOCUMENT = JSON.parse(readFileSync(join(HERE, 'providers.json'), 'utf8'));
export const PROVIDERS = new Map(PROVIDER_DOCUMENT.providers.map((provider) => [provider.id, provider]));

export const MUTATING_OPERATIONS = new Set([
  'createThread', 'reply', 'reviewReply', 'edit', 'delete', 'react', 'resolve', 'reopen', 'mirror',
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
];

export class MessagingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.details = details;
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function assertSafeOutboundText(value, field = 'body') {
  if (value === undefined || value === null) return;
  const text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new MessagingError('SECRET_MATERIAL_REJECTED', `${field} appears to contain credential material; send a reference, not the value`);
    }
  }
}

export function providerById(providerId) {
  const provider = PROVIDERS.get(String(providerId || '').toLowerCase());
  if (!provider) throw new MessagingError('UNKNOWN_PROVIDER', `Unknown messaging provider: ${providerId ?? '<missing>'}`);
  return provider;
}

function requireValue(target, name) {
  const value = target?.[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new MessagingError('TARGET_FIELD_REQUIRED', `Target field ${name} is required`);
  }
  return String(value).trim();
}

function encode(value) {
  return encodeURIComponent(String(value));
}

export function canonicalThreadResource(providerId, target) {
  const provider = String(providerId || '').toLowerCase();
  if (provider === 'slack') {
    const team = requireValue(target, 'teamId').toUpperCase();
    const channel = requireValue(target, 'channelId').toUpperCase();
    const thread = String(target.threadTs || target.messageTs || 'new').trim();
    return `road+message://slack/team/${encode(team)}/channel/${encode(channel)}/thread/${encode(thread)}`;
  }
  if (provider === 'github') {
    const owner = requireValue(target, 'owner').toLowerCase();
    const repo = requireValue(target, 'repo').toLowerCase();
    const number = requireValue(target, 'number');
    const kind = String(target.kind || 'issue').toLowerCase();
    return `road+message://github/repository/${encode(owner)}/${encode(repo)}/${encode(kind)}/${encode(number)}`;
  }
  if (provider === 'linear') {
    const entityType = String(target.entityType || 'issue').toLowerCase();
    return `road+message://linear/${encode(entityType)}/${encode(requireValue(target, 'entityId').toLowerCase())}`;
  }
  if (provider === 'asana') {
    return `road+message://asana/task/${encode(requireValue(target, 'taskId'))}`;
  }
  if (provider === 'notion') {
    return `road+message://notion/page/${encode(requireValue(target, 'pageId').toLowerCase())}`;
  }
  if (provider === 'airtable') {
    return `road+message://airtable/base/${encode(requireValue(target, 'baseId'))}/table/${encode(requireValue(target, 'tableId'))}/record/${encode(requireValue(target, 'recordId'))}`;
  }
  const scope = requireValue(target, 'scope').toLowerCase();
  const thread = String(target.threadId || target.channelId || 'new').trim();
  return `road+message://${encode(provider)}/scope/${encode(scope)}/thread/${encode(thread)}`;
}

export function operationCapability(providerId, operation) {
  const provider = providerById(providerId);
  const spec = provider.operations?.[operation];
  if (!spec) {
    return { supported: false, providerId: provider.id, operation, state: 'UNSUPPORTED', reason: `${provider.label} does not expose ${operation} through the reviewed adapter` };
  }
  return { supported: true, providerId: provider.id, operation, state: provider.status, spec };
}

export function planOperation(input) {
  const provider = providerById(input.providerId);
  const capability = operationCapability(provider.id, input.operation);
  const resourceKey = canonicalThreadResource(provider.id, input.target || {});
  const mutating = MUTATING_OPERATIONS.has(input.operation) || Boolean(capability.spec?.write);

  if (!capability.supported) {
    return { schema: 'road-messaging-operation-plan-v1', state: 'UNSUPPORTED', providerId: provider.id, operation: input.operation, resourceKey, blockers: [capability.reason] };
  }

  const blockers = [];
  if (provider.status !== 'CONNECTED') blockers.push(`provider-state:${provider.status}`);
  if (mutating && !input.agentId) blockers.push('agentId-required');
  if (mutating && !input.sessionRef) blockers.push('sessionRef-required');
  if (mutating && !input.targetOwnerAgent) blockers.push('targetOwnerAgent-required');
  if (mutating && !input.idempotencyKey) blockers.push('idempotencyKey-required');
  if (mutating && !input.userApprovalRef) blockers.push('userApprovalRef-required-for-COMMUNICATE');
  if (mutating) assertSafeOutboundText(input.body, 'body');

  const bodyHash = input.body === undefined ? null : sha256(input.body);
  const requestShape = {
    providerId: provider.id,
    operation: input.operation,
    resourceKey,
    target: input.target,
    bodyHash,
    expectedResourceVersionRef: input.expectedResourceVersionRef || null,
  };

  return {
    schema: 'road-messaging-operation-plan-v1',
    state: blockers.length ? 'BLOCKED' : 'READY',
    providerId: provider.id,
    providerLabel: provider.label,
    providerState: provider.status,
    operation: input.operation,
    actionClass: mutating ? 'COMMUNICATE' : 'READ',
    resourceKey,
    tool: capability.spec.tool,
    requiredArguments: capability.spec.required,
    collaboration: {
      preflightRequired: mutating,
      claimMode: mutating ? 'exclusive' : 'shared',
      agentId: input.agentId || null,
      sessionRef: input.sessionRef || null,
      targetOwnerAgent: input.targetOwnerAgent || null,
      idempotencyKey: input.idempotencyKey || null,
      userApprovalRef: input.userApprovalRef || null,
      governanceRef: input.governanceRef || null,
      expectedResourceVersionRef: input.expectedResourceVersionRef || null,
      requestHash: sha256(stableStringify(requestShape)),
    },
    verification: {
      required: mutating,
      operation: mutating ? 'readThread' : null,
      rule: mutating ? 'provider-native-read-after-write' : 'none',
    },
    blockers,
  };
}

export function normalizeInboundMessage(input) {
  const provider = providerById(input.providerId);
  const resourceKey = canonicalThreadResource(provider.id, input.target || {});
  const body = String(input.body || '');
  const bodyHash = sha256(body);
  const messageRef = String(input.providerMessageRef || '').trim();
  if (!messageRef) throw new MessagingError('MESSAGE_REF_REQUIRED', 'providerMessageRef is required');
  const durable = {
    schema: 'road-message-reference-v1',
    id: `road://message/${provider.id}/${bodyHash.slice(0, 24)}`,
    threadResource: resourceKey,
    providerId: provider.id,
    providerMessageRef: messageRef,
    parentProviderMessageRef: input.parentProviderMessageRef || null,
    authorRef: input.authorRef || null,
    bodyRef: input.bodyRef || `${provider.id}://${encode(messageRef)}/content`,
    bodyHash,
    bodyLength: Buffer.byteLength(body, 'utf8'),
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    attachmentRefs: Array.isArray(input.attachmentRefs) ? input.attachmentRefs : [],
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
    providerVersionRef: input.providerVersionRef || null,
  };
  return { transient: { ...durable, body }, durable };
}

export function planMirror(input) {
  const source = providerById(input.sourceProviderId);
  const destination = providerById(input.destinationProviderId);
  const sourceResource = canonicalThreadResource(source.id, input.sourceTarget || {});
  const destinationResource = canonicalThreadResource(destination.id, input.destinationTarget || {});
  const lineage = Array.isArray(input.lineage) ? [...input.lineage] : [];
  const blockers = [];

  if (source.id === destination.id) blockers.push('source-and-destination-provider-identical');
  if (lineage.includes(destination.id)) blockers.push('mirror-loop-detected');
  if (lineage.length >= 4) blockers.push('mirror-hop-limit-exceeded');
  if (input.sourceState !== 'VERIFIED') blockers.push('source-message-not-verified');
  if (!input.userApprovalRef) blockers.push('userApprovalRef-required-for-cross-provider-communication');
  if (input.bidirectional === true) blockers.push('bidirectional-mirroring-disabled-by-default');
  if (destination.status !== 'CONNECTED') blockers.push(`destination-provider-state:${destination.status}`);
  assertSafeOutboundText(input.body, 'body');

  const bodyHash = sha256(String(input.body || ''));
  return {
    schema: 'road-message-mirror-plan-v1',
    state: blockers.length ? 'BLOCKED' : 'READY',
    authority: { providerId: source.id, resourceKey: sourceResource },
    projection: { providerId: destination.id, resourceKey: destinationResource },
    direction: 'OUTBOUND_PROJECTION',
    bidirectional: false,
    bodyHash,
    lineage: [...lineage, source.id],
    dedupeKey: sha256(stableStringify({ sourceResource, destinationResource, bodyHash, providerMessageRef: input.providerMessageRef || null })),
    actionClass: 'COMMUNICATE',
    requiresExclusiveDestinationClaim: true,
    verification: 'destination-provider-native-read-after-write',
    blockers,
  };
}

export function classifyOutcome(input) {
  const kind = String(input.kind || '').toLowerCase();
  if (kind === 'timeout') return { state: 'TIMEOUT_UNKNOWN', terminal: false, retryAllowed: false, next: 'provider-read-back-before-retry' };
  if (kind === 'auth-required') return { state: 'AUTH_REQUIRED', terminal: true, retryAllowed: false, next: 'repair-provider-authentication' };
  if (kind === 'auth-failed') return { state: 'AUTH_FAILED', terminal: true, retryAllowed: false, next: 'repair-provider-authentication' };
  if (kind === 'conflict') return { state: 'CONFLICT', terminal: true, retryAllowed: false, next: 'reobserve-resource-and-replan' };
  if (kind === 'unsupported') return { state: 'UNSUPPORTED', terminal: true, retryAllowed: false, next: 'select-supported-provider-operation' };
  if (kind === 'rate-limit') return { state: 'RETRYABLE', terminal: false, retryAllowed: true, next: 'retry-after-provider-window' };
  if (kind === 'failure') return { state: 'FAILED', terminal: true, retryAllowed: false, next: 'inspect-provider-error' };
  if (kind === 'success' && Number(input.count) === 0 && input.mutating !== true) {
    return { state: 'EMPTY_OBSERVATION', terminal: true, retryAllowed: false, exists: 'unknown', next: 'preserve-empty-evidence' };
  }
  if (kind === 'success' && input.mutating === true) {
    if (input.verificationMatched === true) return { state: 'VERIFIED', terminal: true, retryAllowed: false, next: 'record-succeeded-receipt' };
    return { state: 'VERIFYING', terminal: false, retryAllowed: false, next: 'provider-native-read-after-write' };
  }
  if (kind === 'success') return { state: 'SUCCEEDED', terminal: true, retryAllowed: false, next: 'record-read-receipt' };
  return { state: 'UNKNOWN', terminal: false, retryAllowed: false, next: 'inspect-provider-state' };
}

export function planReceipt(input) {
  const mutating = input.actionClass === 'COMMUNICATE';
  if (mutating && input.outcomeState === 'SUCCEEDED') {
    throw new MessagingError('UNVERIFIED_MUTATION_RECEIPT', 'COMMUNICATE operations require VERIFIED, not bare SUCCEEDED');
  }
  if (mutating && input.outcomeState === 'VERIFIED' && !input.verificationRef) {
    throw new MessagingError('VERIFICATION_REF_REQUIRED', 'Verified messaging mutations require a provider read-back reference');
  }
  return {
    schema: 'road-messaging-receipt-v1',
    operationId: input.operationId,
    connectorId: input.providerId,
    resourceKey: input.resourceKey,
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    actionClass: input.actionClass,
    outcomeState: input.outcomeState,
    providerRequestRef: input.providerRequestRef || null,
    verificationRef: input.verificationRef || null,
    idempotencyKey: input.idempotencyKey || null,
    secretValuesPersisted: false,
    bodyPersisted: false,
    bodyHash: input.bodyHash || null,
    recordedAt: input.recordedAt || new Date().toISOString(),
  };
}

export function reactionMeaning(emoji) {
  const normalized = String(emoji || '').replaceAll(':', '').toLowerCase();
  const meanings = {
    eyes: 'SEEN',
    white_check_mark: 'ACKNOWLEDGED',
    thumbsup: 'SUPPORTED',
    '+1': 'SUPPORTED',
    x: 'DISAGREED',
    warning: 'ATTENTION',
  };
  return {
    emoji: normalized,
    meaning: meanings[normalized] || 'SOCIAL_SIGNAL',
    grantsAuthority: false,
    satisfiesGovernance: false,
    satisfiesUserApproval: false,
  };
}

export function providerSnapshot() {
  return PROVIDER_DOCUMENT.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    status: provider.status,
    surface: provider.surface,
    adapter: provider.adapter || null,
    operations: Object.keys(provider.operations),
  }));
}
