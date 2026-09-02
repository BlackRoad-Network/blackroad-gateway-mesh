import { createHash, randomUUID } from 'node:crypto';

export const PROTOCOL_VERSION = '1.0';
export const AGENT_ID_PATTERN = /^agent-instance-[1-6]$/;
export const RUNTIMES = new Set(['claude', 'chatgpt', 'codex', 'roadie', 'human', 'other']);
export const MUTATION_MODES = new Set(['write', 'deploy', 'admin', 'secret', 'public-exposure']);
export const CLAIM_RESULTS = new Set(['succeeded', 'failed', 'unknown', 'cancelled', 'compensated']);
export const HANDOFF_STATES = new Set(['offered', 'accepted', 'in_progress', 'completed', 'rejected', 'expired']);

const SECRET_PATTERNS = [
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*(?!false\b|true\b|null\b|reference\b|ref\b)[^\s,;]{8,}/i,
];

const SENSITIVE_KEYS = /(?:secret|password|passwd|token|authorization|cookie|private[_-]?key|api[_-]?key|credential|refresh[_-]?token)/i;

export class CollaborationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CollaborationError';
    this.code = code;
    this.details = details;
  }
}

export function isoNow(now = new Date()) {
  return new Date(now).toISOString();
}

export function makeId(prefix, idFactory = null) {
  const value = idFactory ? idFactory(prefix) : randomUUID();
  return `${prefix}_${value}`;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function assertAgentId(agentId) {
  if (!AGENT_ID_PATTERN.test(String(agentId ?? ''))) {
    throw new CollaborationError('INVALID_AGENT_ID', `Expected agent-instance-1 through agent-instance-6, received ${agentId ?? '<missing>'}`);
  }
}

export function assertSafeText(value, field = 'text') {
  if (value === undefined || value === null) return;
  const text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new CollaborationError('SECRET_MATERIAL_REJECTED', `${field} appears to contain secret material; provide a reference instead of a value`);
    }
  }
}

export function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map(sanitizePublic);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED_REFERENCE_ONLY]' : sanitizePublic(nested);
    }
    return output;
  }
  if (typeof value === 'string') {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return '[REDACTED_SECRET_PATTERN]';
    return value;
  }
  return value;
}

export function createEmptyState() {
  return {
    schema: 'road-collaboration-state-v1',
    protocolVersion: PROTOCOL_VERSION,
    sessions: [],
    claims: [],
    handoffs: [],
    receipts: [],
    events: [],
  };
}

function cloneState(state) {
  return structuredClone(state ?? createEmptyState());
}

function asDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CollaborationError('INVALID_TIMESTAMP', `Invalid timestamp: ${value}`);
  }
  return date;
}

function boundedTtlSeconds(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function addSeconds(now, seconds) {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

function event(state, input, context = {}) {
  const emitted = {
    id: makeId('evt', context.idFactory),
    version: PROTOCOL_VERSION,
    type: input.type,
    timestamp: isoNow(context.now),
    actor: input.actor ?? { kind: 'service', id: 'road://service/collaboration' },
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    connectorId: input.connectorId ?? null,
    targetRef: input.targetRef ?? null,
    classification: input.classification ?? 'operational',
    payloadRefs: input.payloadRefs ?? [],
    summary: input.summary ?? null,
  };
  assertSafeText(emitted.summary, 'event.summary');
  state.events.push(emitted);
  return emitted;
}

export function resourceKey(connectorId, targetRef) {
  if (!connectorId || !targetRef) {
    throw new CollaborationError('MISSING_RESOURCE_KEY', 'connectorId and targetRef are required');
  }
  return `${String(connectorId).toLowerCase()}::${String(targetRef)}`;
}

export function isMutationMode(mode) {
  return MUTATION_MODES.has(mode);
}

export function reapExpired(state, options = {}) {
  const next = cloneState(state);
  const now = asDate(options.now ?? new Date());

  for (const session of next.sessions) {
    if (session.state === 'active' && asDate(session.expiresAt) <= now) {
      session.state = 'expired';
      session.expiredAt = isoNow(now);
      event(next, {
        type: 'road.collaboration.session.expired',
        actor: { kind: 'service', id: 'road://service/collaboration' },
        correlationId: session.correlationId,
        summary: `Session ${session.id} expired`,
      }, { ...options, now });
    }
  }

  for (const claim of next.claims) {
    if (claim.state === 'active' && asDate(claim.expiresAt) <= now) {
      claim.state = 'expired';
      claim.expiredAt = isoNow(now);
      event(next, {
        type: 'road.collaboration.claim.expired',
        actor: { kind: 'service', id: 'road://service/collaboration' },
        correlationId: claim.correlationId,
        connectorId: claim.connectorId,
        targetRef: claim.targetRef,
        summary: `Claim ${claim.id} expired`,
      }, { ...options, now });
    }
  }

  for (const handoff of next.handoffs) {
    if (['offered', 'accepted', 'in_progress'].includes(handoff.state) && asDate(handoff.expiresAt) <= now) {
      handoff.state = 'expired';
      handoff.expiredAt = isoNow(now);
      event(next, {
        type: 'road.collaboration.handoff.expired',
        actor: { kind: 'service', id: 'road://service/collaboration' },
        correlationId: handoff.correlationId,
        summary: `Handoff ${handoff.id} expired`,
      }, { ...options, now });
    }
  }

  return next;
}

export function registerSession(state, input, options = {}) {
  assertAgentId(input.agentId);
  if (!RUNTIMES.has(input.runtime)) {
    throw new CollaborationError('INVALID_RUNTIME', `Unsupported runtime: ${input.runtime}`);
  }
  assertSafeText(input.model, 'session.model');
  assertSafeText(input.workspace, 'session.workspace');

  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const ttlSeconds = boundedTtlSeconds(input.ttlSeconds, 3600, 60, 86400);
  const id = input.sessionId || makeId('session', options.idFactory);

  const existing = next.sessions.find((session) => session.id === id);
  if (existing && existing.state === 'active') {
    if (existing.agentId !== input.agentId || existing.runtime !== input.runtime) {
      throw new CollaborationError('SESSION_ID_COLLISION', `Session ${id} is already bound to another actor`);
    }
    existing.lastHeartbeatAt = isoNow(now);
    existing.expiresAt = addSeconds(now, ttlSeconds);
    return { state: next, session: existing, replay: true };
  }

  const correlationId = input.correlationId || makeId('corr', options.idFactory);
  const session = {
    id,
    version: PROTOCOL_VERSION,
    agentId: input.agentId,
    agentUri: `road://agent/${input.agentId}`,
    runtime: input.runtime,
    model: input.model ?? null,
    workspace: input.workspace ?? '/Users/alexa/workspace',
    state: 'active',
    correlationId,
    startedAt: isoNow(now),
    lastHeartbeatAt: isoNow(now),
    expiresAt: addSeconds(now, ttlSeconds),
    capabilities: input.capabilities ?? [],
  };
  next.sessions.push(session);
  event(next, {
    type: 'road.collaboration.session.registered',
    actor: { kind: 'agent', agentId: input.agentId, sessionId: id, runtime: input.runtime },
    correlationId,
    summary: `Registered ${input.agentId} session ${id}`,
  }, { ...options, now });
  return { state: next, session, replay: false };
}

export function heartbeatSession(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const ttlSeconds = boundedTtlSeconds(input.ttlSeconds, 3600, 60, 86400);
  const session = next.sessions.find((item) => item.id === input.sessionId);
  if (!session || session.state !== 'active') {
    throw new CollaborationError('SESSION_NOT_ACTIVE', `Session ${input.sessionId} is not active`);
  }
  session.lastHeartbeatAt = isoNow(now);
  session.expiresAt = addSeconds(now, ttlSeconds);
  event(next, {
    type: 'road.collaboration.session.heartbeat',
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId: session.correlationId,
    summary: `Heartbeat for ${session.id}`,
  }, { ...options, now });
  return { state: next, session };
}

function requireActiveSession(state, sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || session.state !== 'active') {
    throw new CollaborationError('SESSION_NOT_ACTIVE', `Session ${sessionId} is not active`);
  }
  return session;
}

export function requestClaim(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const session = requireActiveSession(next, input.sessionId);
  if (!isMutationMode(input.mode)) {
    throw new CollaborationError('CLAIM_NOT_REQUIRED_FOR_READ', `Mode ${input.mode} does not require a mutation claim`);
  }
  if (!input.idempotencyKey) {
    throw new CollaborationError('IDEMPOTENCY_KEY_REQUIRED', 'Mutation claims require an idempotency key');
  }
  assertSafeText(input.summary, 'claim.summary');
  assertSafeText(input.targetRef, 'claim.targetRef');
  assertSafeText(input.expectedVersion, 'claim.expectedVersion');

  const key = resourceKey(input.connectorId, input.targetRef);
  const sameRequest = next.claims.find((claim) =>
    claim.state === 'active' &&
    claim.idempotencyKey === input.idempotencyKey &&
    claim.sessionId === input.sessionId &&
    claim.resourceKey === key
  );
  if (sameRequest) return { state: next, claim: sameRequest, replay: true };

  const conflict = next.claims.find((claim) => claim.state === 'active' && claim.resourceKey === key);
  if (conflict) {
    throw new CollaborationError('TARGET_LEASE_CONFLICT', `Target is already claimed by ${conflict.agentId}`, {
      conflictingClaimId: conflict.id,
      agentId: conflict.agentId,
      expiresAt: conflict.expiresAt,
    });
  }

  const activeForAgent = next.claims.filter((claim) => claim.state === 'active' && claim.agentId === session.agentId);
  const maximumConcurrentMutations = Number.isInteger(input.maximumConcurrentMutations)
    ? input.maximumConcurrentMutations
    : 1;
  if (activeForAgent.length >= maximumConcurrentMutations) {
    throw new CollaborationError('AGENT_MUTATION_LIMIT', `${session.agentId} already has its allowed active mutation`, {
      activeClaimIds: activeForAgent.map((claim) => claim.id),
    });
  }

  const ttlSeconds = boundedTtlSeconds(input.ttlSeconds, 900, 15, 3600);
  const operationId = input.operationId || makeId('op', options.idFactory);
  const correlationId = input.correlationId || session.correlationId || makeId('corr', options.idFactory);
  const claim = {
    id: makeId('claim', options.idFactory),
    version: PROTOCOL_VERSION,
    operationId,
    idempotencyKey: input.idempotencyKey,
    correlationId,
    causationId: input.causationId ?? null,
    sessionId: session.id,
    agentId: session.agentId,
    runtime: session.runtime,
    connectorId: String(input.connectorId).toLowerCase(),
    targetRef: input.targetRef,
    resourceKey: key,
    mode: input.mode,
    operation: input.operation,
    summary: input.summary ?? null,
    expectedVersion: input.expectedVersion ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    state: 'active',
    acquiredAt: isoNow(now),
    expiresAt: addSeconds(now, ttlSeconds),
  };
  next.claims.push(claim);
  event(next, {
    type: 'road.collaboration.claim.acquired',
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId,
    causationId: input.causationId ?? null,
    connectorId: claim.connectorId,
    targetRef: claim.targetRef,
    payloadRefs: claim.evidenceRefs,
    summary: `Claimed ${claim.resourceKey} for ${claim.mode}`,
  }, { ...options, now });
  return { state: next, claim, replay: false };
}

export function completeClaim(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const session = requireActiveSession(next, input.sessionId);
  const claim = next.claims.find((item) => item.id === input.claimId);
  if (!claim) throw new CollaborationError('CLAIM_NOT_FOUND', `Claim ${input.claimId} was not found`);
  if (claim.state !== 'active') throw new CollaborationError('CLAIM_NOT_ACTIVE', `Claim ${claim.id} is ${claim.state}`);
  if (claim.sessionId !== session.id) throw new CollaborationError('CLAIM_OWNER_MISMATCH', `Claim ${claim.id} belongs to another session`);
  if (!CLAIM_RESULTS.has(input.result)) throw new CollaborationError('INVALID_RESULT', `Unsupported result: ${input.result}`);
  assertSafeText(input.errorCode, 'receipt.errorCode');
  assertSafeText(input.observedVersion, 'receipt.observedVersion');
  assertSafeText(input.resultingVersion, 'receipt.resultingVersion');

  claim.state = 'completed';
  claim.completedAt = isoNow(now);
  claim.result = input.result;

  const receipt = {
    id: makeId('receipt', options.idFactory),
    version: PROTOCOL_VERSION,
    operationId: claim.operationId,
    idempotencyKey: claim.idempotencyKey,
    correlationId: claim.correlationId,
    causationId: claim.causationId,
    claimRef: claim.id,
    actor: {
      agentId: session.agentId,
      sessionId: session.id,
      runtime: session.runtime,
    },
    connectorId: claim.connectorId,
    targetRef: claim.targetRef,
    operation: claim.operation,
    mode: claim.mode,
    startedAt: claim.acquiredAt,
    completedAt: isoNow(now),
    result: input.result,
    expectedVersion: claim.expectedVersion,
    observedVersion: input.observedVersion ?? null,
    resultingVersion: input.resultingVersion ?? null,
    evidenceRefs: [...new Set([...(claim.evidenceRefs ?? []), ...(input.evidenceRefs ?? [])])],
    errorCode: input.errorCode ?? null,
    secretValuesPersisted: false,
    redactions: input.redactions ?? [],
  };
  next.receipts.push(receipt);
  event(next, {
    type: `road.collaboration.operation.${input.result}`,
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId: claim.correlationId,
    causationId: claim.id,
    connectorId: claim.connectorId,
    targetRef: claim.targetRef,
    payloadRefs: receipt.evidenceRefs,
    classification: input.result === 'succeeded' ? 'success' : input.result,
    summary: `Operation ${claim.operationId} ${input.result}`,
  }, { ...options, now });
  return { state: next, claim, receipt };
}

export function createHandoff(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const session = requireActiveSession(next, input.fromSessionId);
  assertAgentId(input.toAgentId);
  if (input.toAgentId === session.agentId) {
    throw new CollaborationError('SELF_HANDOFF_REJECTED', 'A handoff must cross an agent boundary');
  }
  assertSafeText(input.summary, 'handoff.summary');
  assertSafeText(input.requiredAction, 'handoff.requiredAction');
  const ttlSeconds = boundedTtlSeconds(input.ttlSeconds, 86400, 60, 604800);
  const correlationId = input.correlationId || session.correlationId || makeId('corr', options.idFactory);
  const handoff = {
    id: makeId('handoff', options.idFactory),
    version: PROTOCOL_VERSION,
    correlationId,
    causationId: input.causationId ?? null,
    from: { agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    toAgentId: input.toAgentId,
    kind: input.kind,
    summary: input.summary,
    requiredAction: input.requiredAction ?? null,
    connectorIds: input.connectorIds ?? [],
    targetRefs: input.targetRefs ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    state: 'offered',
    createdAt: isoNow(now),
    expiresAt: addSeconds(now, ttlSeconds),
    acknowledgedBy: null,
    acknowledgedAt: null,
    completedAt: null,
  };
  next.handoffs.push(handoff);
  event(next, {
    type: 'road.collaboration.handoff.offered',
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId,
    causationId: input.causationId ?? null,
    payloadRefs: handoff.evidenceRefs,
    summary: `Handoff ${handoff.id} offered to ${input.toAgentId}`,
  }, { ...options, now });
  return { state: next, handoff };
}

export function acknowledgeHandoff(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const session = requireActiveSession(next, input.sessionId);
  const handoff = next.handoffs.find((item) => item.id === input.handoffId);
  if (!handoff) throw new CollaborationError('HANDOFF_NOT_FOUND', `Handoff ${input.handoffId} was not found`);
  if (handoff.state !== 'offered') throw new CollaborationError('HANDOFF_NOT_OFFERED', `Handoff ${handoff.id} is ${handoff.state}`);
  if (handoff.toAgentId !== session.agentId) {
    throw new CollaborationError('HANDOFF_RECIPIENT_MISMATCH', `Handoff ${handoff.id} is addressed to ${handoff.toAgentId}`);
  }
  handoff.state = 'accepted';
  handoff.acknowledgedBy = { agentId: session.agentId, sessionId: session.id, runtime: session.runtime };
  handoff.acknowledgedAt = isoNow(now);
  event(next, {
    type: 'road.collaboration.handoff.accepted',
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId: handoff.correlationId,
    causationId: handoff.id,
    payloadRefs: handoff.evidenceRefs,
    summary: `Handoff ${handoff.id} accepted by ${session.agentId}`,
  }, { ...options, now });
  return { state: next, handoff };
}

export function finishHandoff(state, input, options = {}) {
  let next = reapExpired(state, options);
  const now = asDate(options.now ?? new Date());
  const session = requireActiveSession(next, input.sessionId);
  const handoff = next.handoffs.find((item) => item.id === input.handoffId);
  if (!handoff) throw new CollaborationError('HANDOFF_NOT_FOUND', `Handoff ${input.handoffId} was not found`);
  if (!['accepted', 'in_progress'].includes(handoff.state)) {
    throw new CollaborationError('HANDOFF_NOT_ACTIVE', `Handoff ${handoff.id} is ${handoff.state}`);
  }
  if (handoff.toAgentId !== session.agentId) {
    throw new CollaborationError('HANDOFF_RECIPIENT_MISMATCH', `Handoff ${handoff.id} is addressed to ${handoff.toAgentId}`);
  }
  const result = input.result ?? 'completed';
  if (!['completed', 'rejected'].includes(result)) {
    throw new CollaborationError('INVALID_HANDOFF_RESULT', `Unsupported handoff result: ${result}`);
  }
  handoff.state = result;
  handoff.completedAt = isoNow(now);
  handoff.resultEvidenceRefs = input.evidenceRefs ?? [];
  event(next, {
    type: `road.collaboration.handoff.${result}`,
    actor: { kind: 'agent', agentId: session.agentId, sessionId: session.id, runtime: session.runtime },
    correlationId: handoff.correlationId,
    causationId: handoff.id,
    payloadRefs: input.evidenceRefs ?? [],
    summary: `Handoff ${handoff.id} ${result}`,
  }, { ...options, now });
  return { state: next, handoff };
}

export function classifyObservation(input = {}) {
  const kind = String(input.kind ?? '').toLowerCase();
  const code = String(input.errorCode ?? '').toUpperCase();
  if (kind === 'timeout' || code.includes('TIMEOUT')) {
    return { state: 'TIMEOUT_UNKNOWN', exists: 'unknown', retryable: true };
  }
  if (kind === 'zero' || (input.ok === true && Number(input.count) === 0)) {
    return { state: 'EMPTY_OBSERVATION', exists: 'unknown', retryable: false };
  }
  if (kind === 'auth-rejected' || code.includes('AUTH') || code.includes('UNAUTHORIZED')) {
    return { state: 'AUTH_FAILED', exists: 'unknown', retryable: false };
  }
  if (kind === 'forbidden' || code.includes('FORBIDDEN') || code === '403') {
    return { state: 'FORBIDDEN', exists: 'unknown', retryable: false };
  }
  if (kind === 'connection-refused' || code.includes('CONNECTION_REFUSED')) {
    return { state: 'REACHABLE_NO_SERVICE', exists: true, retryable: true };
  }
  if (kind === 'not-found' || code === '404') {
    return { state: 'NOT_FOUND_OBSERVED', exists: 'unknown', retryable: false };
  }
  if (input.ok === true || kind === 'success') {
    return { state: 'SUCCEEDED', exists: true, retryable: false };
  }
  return { state: 'UNKNOWN_ERROR', exists: 'unknown', retryable: true };
}

export function validateOperationEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object') return ['envelope must be an object'];
  if (envelope.version !== PROTOCOL_VERSION) errors.push(`version must be ${PROTOCOL_VERSION}`);
  for (const field of ['operationId', 'idempotencyKey', 'correlationId', 'createdAt']) {
    if (!envelope[field]) errors.push(`${field} is required`);
  }
  if (!envelope.actor?.agentId) errors.push('actor.agentId is required');
  else if (!AGENT_ID_PATTERN.test(envelope.actor.agentId)) errors.push('actor.agentId is invalid');
  if (!envelope.actor?.sessionId) errors.push('actor.sessionId is required');
  if (!envelope.connector?.id) errors.push('connector.id is required');
  if (!envelope.connector?.operation) errors.push('connector.operation is required');
  if (!envelope.connector?.authorityClass) errors.push('connector.authorityClass is required');
  if (!envelope.target?.ref) errors.push('target.ref is required');
  if (isMutationMode(envelope.connector?.authorityClass) && !envelope.claimRef) {
    errors.push('claimRef is required for mutation authority classes');
  }
  try {
    assertSafeText(JSON.stringify(envelope), 'operation envelope');
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

export function doctorState(state, options = {}) {
  const inspected = reapExpired(state, options);
  const issues = [];
  const activeClaims = inspected.claims.filter((claim) => claim.state === 'active');
  const byResource = new Map();
  const byAgent = new Map();
  for (const claim of activeClaims) {
    if (byResource.has(claim.resourceKey)) issues.push(`duplicate active resource claim: ${claim.resourceKey}`);
    byResource.set(claim.resourceKey, claim.id);
    const count = (byAgent.get(claim.agentId) ?? 0) + 1;
    byAgent.set(claim.agentId, count);
    if (count > 1) issues.push(`agent mutation limit exceeded: ${claim.agentId}`);
    const session = inspected.sessions.find((item) => item.id === claim.sessionId);
    if (!session || session.state !== 'active') issues.push(`claim ${claim.id} has no active session`);
  }
  const receiptOperationIds = new Set();
  for (const receipt of inspected.receipts) {
    if (receiptOperationIds.has(receipt.operationId)) issues.push(`duplicate receipt operationId: ${receipt.operationId}`);
    receiptOperationIds.add(receipt.operationId);
    if (receipt.secretValuesPersisted !== false) issues.push(`receipt ${receipt.id} does not assert secretValuesPersisted=false`);
  }
  for (const handoff of inspected.handoffs) {
    if (!AGENT_ID_PATTERN.test(handoff.toAgentId)) issues.push(`handoff ${handoff.id} has invalid recipient`);
    if (!HANDOFF_STATES.has(handoff.state)) issues.push(`handoff ${handoff.id} has invalid state ${handoff.state}`);
  }
  try {
    assertSafeText(JSON.stringify(inspected), 'collaboration state');
  } catch (error) {
    issues.push(error.message);
  }
  return {
    state: inspected,
    ok: issues.length === 0,
    issues,
    counts: {
      sessions: inspected.sessions.length,
      activeSessions: inspected.sessions.filter((session) => session.state === 'active').length,
      claims: inspected.claims.length,
      activeClaims: activeClaims.length,
      handoffs: inspected.handoffs.length,
      offeredHandoffs: inspected.handoffs.filter((handoff) => handoff.state === 'offered').length,
      receipts: inspected.receipts.length,
      events: inspected.events.length,
    },
  };
}

export function publicStatus(state, options = {}) {
  const report = doctorState(state, options);
  return sanitizePublic({
    schema: 'road-collaboration-public-status-v1',
    generatedAt: isoNow(options.now ?? new Date()),
    healthy: report.ok,
    counts: report.counts,
    activeAgents: report.state.sessions
      .filter((session) => session.state === 'active')
      .map((session) => ({ agentId: session.agentId, runtime: session.runtime, lastHeartbeatAt: session.lastHeartbeatAt })),
    activeClaims: report.state.claims
      .filter((claim) => claim.state === 'active')
      .map((claim) => ({ agentId: claim.agentId, connectorId: claim.connectorId, mode: claim.mode, expiresAt: claim.expiresAt })),
    pendingHandoffs: report.state.handoffs
      .filter((handoff) => handoff.state === 'offered')
      .map((handoff) => ({ fromAgentId: handoff.from.agentId, toAgentId: handoff.toAgentId, kind: handoff.kind, createdAt: handoff.createdAt })),
  });
}
