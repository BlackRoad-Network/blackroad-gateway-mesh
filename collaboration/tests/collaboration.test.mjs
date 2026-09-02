import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeHandoff,
  classifyObservation,
  CollaborationError,
  completeClaim,
  createEmptyState,
  createHandoff,
  doctorState,
  publicStatus,
  registerSession,
  requestClaim,
  sanitizePublic,
  validateOperationEnvelope,
} from '../core.mjs';

function ids() {
  let counter = 0;
  return (prefix) => `${prefix}-${++counter}`;
}

function register(state, agentId, runtime, now, idFactory) {
  return registerSession(state, {
    agentId,
    runtime,
    sessionId: `session_${agentId}_${runtime}`,
    workspace: '/Users/alexa/workspace',
  }, { now, idFactory });
}

test('registers six-agent runtime sessions without treating runtime as authority', () => {
  const idFactory = ids();
  let state = createEmptyState();
  const result = register(state, 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  state = result.state;
  assert.equal(result.session.agentUri, 'road://agent/agent-instance-4');
  assert.equal(result.session.runtime, 'claude');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.events[0].type, 'road.collaboration.session.registered');
});

test('rejects identities outside the six canonical agents', () => {
  assert.throws(
    () => registerSession(createEmptyState(), { agentId: 'agent-instance-7', runtime: 'claude' }),
    (error) => error instanceof CollaborationError && error.code === 'INVALID_AGENT_ID',
  );
});

test('requires idempotency keys for connector mutations', () => {
  const idFactory = ids();
  const session = register(createEmptyState(), 'agent-instance-4', 'chatgpt', '2026-09-02T00:00:00Z', idFactory);
  assert.throws(
    () => requestClaim(session.state, {
      sessionId: session.session.id,
      connectorId: 'github',
      targetRef: 'repo@branch:path',
      mode: 'write',
      operation: 'file.update',
    }, { now: '2026-09-02T00:00:01Z', idFactory }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
});

test('prevents two agents from mutating the same connector target', () => {
  const idFactory = ids();
  let state = createEmptyState();
  const first = register(state, 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  state = first.state;
  const second = register(state, 'agent-instance-5', 'chatgpt', '2026-09-02T00:00:00Z', idFactory);
  state = second.state;
  const claim = requestClaim(state, {
    sessionId: first.session.id,
    connectorId: 'github',
    targetRef: 'BlackRoad-Network/repo@branch:file',
    mode: 'write',
    operation: 'file.update',
    idempotencyKey: 'first-write',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  assert.throws(
    () => requestClaim(claim.state, {
      sessionId: second.session.id,
      connectorId: 'github',
      targetRef: 'BlackRoad-Network/repo@branch:file',
      mode: 'write',
      operation: 'file.update',
      idempotencyKey: 'second-write',
    }, { now: '2026-09-02T00:00:02Z', idFactory }),
    (error) => error.code === 'TARGET_LEASE_CONFLICT',
  );
});

test('enforces one concurrent mutation per stable agent across sessions', () => {
  const idFactory = ids();
  let state = createEmptyState();
  const first = registerSession(state, {
    agentId: 'agent-instance-4', runtime: 'claude', sessionId: 'session_agent4_claude',
  }, { now: '2026-09-02T00:00:00Z', idFactory });
  state = first.state;
  const second = registerSession(state, {
    agentId: 'agent-instance-4', runtime: 'chatgpt', sessionId: 'session_agent4_chatgpt',
  }, { now: '2026-09-02T00:00:00Z', idFactory });
  state = second.state;
  const claim = requestClaim(state, {
    sessionId: first.session.id,
    connectorId: 'github',
    targetRef: 'repo@branch:file-a',
    mode: 'write', operation: 'file.update', idempotencyKey: 'write-a',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  assert.throws(
    () => requestClaim(claim.state, {
      sessionId: second.session.id,
      connectorId: 'linear',
      targetRef: 'issue-2',
      mode: 'write', operation: 'issue.update', idempotencyKey: 'write-b',
    }, { now: '2026-09-02T00:00:02Z', idFactory }),
    (error) => error.code === 'AGENT_MUTATION_LIMIT',
  );
});

test('replays an identical active claim instead of duplicating it', () => {
  const idFactory = ids();
  const session = register(createEmptyState(), 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  const first = requestClaim(session.state, {
    sessionId: session.session.id,
    connectorId: 'github', targetRef: 'repo@branch:file', mode: 'write', operation: 'file.update', idempotencyKey: 'same',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  const second = requestClaim(first.state, {
    sessionId: session.session.id,
    connectorId: 'github', targetRef: 'repo@branch:file', mode: 'write', operation: 'file.update', idempotencyKey: 'same',
  }, { now: '2026-09-02T00:00:02Z', idFactory });
  assert.equal(second.replay, true);
  assert.equal(second.claim.id, first.claim.id);
  assert.equal(second.state.claims.length, 1);
});

test('completion releases the target and creates a receipt', () => {
  const idFactory = ids();
  const session = register(createEmptyState(), 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  const claimed = requestClaim(session.state, {
    sessionId: session.session.id,
    connectorId: 'github', targetRef: 'repo@branch:file', mode: 'write', operation: 'file.update', idempotencyKey: 'complete-me',
    expectedVersion: 'old-sha',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  const completed = completeClaim(claimed.state, {
    sessionId: session.session.id,
    claimId: claimed.claim.id,
    result: 'succeeded',
    observedVersion: 'old-sha',
    resultingVersion: 'new-sha',
    evidenceRefs: ['github:commit/new-sha'],
  }, { now: '2026-09-02T00:00:02Z', idFactory });
  assert.equal(completed.claim.state, 'completed');
  assert.equal(completed.receipt.secretValuesPersisted, false);
  assert.equal(completed.receipt.resultingVersion, 'new-sha');
  assert.equal(completed.state.receipts.length, 1);
});

test('expired claims no longer block another agent', () => {
  const idFactory = ids();
  let state = createEmptyState();
  const first = register(state, 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  state = first.state;
  const second = register(state, 'agent-instance-5', 'chatgpt', '2026-09-02T00:00:00Z', idFactory);
  state = second.state;
  const claim = requestClaim(state, {
    sessionId: first.session.id,
    connectorId: 'github', targetRef: 'repo@branch:file', mode: 'write', operation: 'file.update', idempotencyKey: 'expiring', ttlSeconds: 15,
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  const replacement = requestClaim(claim.state, {
    sessionId: second.session.id,
    connectorId: 'github', targetRef: 'repo@branch:file', mode: 'write', operation: 'file.update', idempotencyKey: 'replacement',
  }, { now: '2026-09-02T00:00:17Z', idFactory });
  assert.equal(replacement.claim.agentId, 'agent-instance-5');
  assert.equal(replacement.state.claims[0].state, 'expired');
});

test('handoffs require acknowledgement by the addressed agent', () => {
  const idFactory = ids();
  let state = createEmptyState();
  const sender = register(state, 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  state = sender.state;
  const recipient = register(state, 'agent-instance-3', 'chatgpt', '2026-09-02T00:00:00Z', idFactory);
  state = recipient.state;
  const stranger = register(state, 'agent-instance-2', 'codex', '2026-09-02T00:00:00Z', idFactory);
  state = stranger.state;
  const offered = createHandoff(state, {
    fromSessionId: sender.session.id,
    toAgentId: 'agent-instance-3',
    kind: 'domain-resolution',
    summary: 'Resolve road://service/gateway',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  assert.throws(
    () => acknowledgeHandoff(offered.state, { sessionId: stranger.session.id, handoffId: offered.handoff.id }, { now: '2026-09-02T00:00:02Z', idFactory }),
    (error) => error.code === 'HANDOFF_RECIPIENT_MISMATCH',
  );
  const accepted = acknowledgeHandoff(offered.state, { sessionId: recipient.session.id, handoffId: offered.handoff.id }, { now: '2026-09-02T00:00:02Z', idFactory });
  assert.equal(accepted.handoff.state, 'accepted');
});

test('classifies zero and timeout without claiming nonexistence', () => {
  assert.deepEqual(classifyObservation({ kind: 'timeout' }), { state: 'TIMEOUT_UNKNOWN', exists: 'unknown', retryable: true });
  assert.deepEqual(classifyObservation({ ok: true, count: 0 }), { state: 'EMPTY_OBSERVATION', exists: 'unknown', retryable: false });
  assert.deepEqual(classifyObservation({ kind: 'connection-refused' }), { state: 'REACHABLE_NO_SERVICE', exists: true, retryable: true });
});

test('rejects likely secret values in collaboration metadata', () => {
  const idFactory = ids();
  const session = register(createEmptyState(), 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  assert.throws(
    () => requestClaim(session.state, {
      sessionId: session.session.id,
      connectorId: 'github', targetRef: 'repo', mode: 'write', operation: 'file.update', idempotencyKey: 'secret-test',
      summary: 'Bearer abcdefghijklmnopqrstuvwxyz',
    }, { now: '2026-09-02T00:00:01Z', idFactory }),
    (error) => error.code === 'SECRET_MATERIAL_REJECTED',
  );
});

test('sanitizes secret-shaped object keys from public status', () => {
  const output = sanitizePublic({ token: 'not-even-needed', nested: { apiKey: 'also-no' }, safe: 'yes' });
  assert.equal(output.token, '[REDACTED_REFERENCE_ONLY]');
  assert.equal(output.nested.apiKey, '[REDACTED_REFERENCE_ONLY]');
  assert.equal(output.safe, 'yes');
});

test('operation envelope validation requires a claim for mutations', () => {
  const envelope = {
    version: '1.0', operationId: 'op-1', idempotencyKey: 'id-1', correlationId: 'corr-1', createdAt: '2026-09-02T00:00:00Z',
    actor: { agentId: 'agent-instance-4', sessionId: 'session_example', runtime: 'claude' },
    connector: { id: 'github', operation: 'file.update', authorityClass: 'write' },
    target: { kind: 'repository-path', ref: 'repo@branch:file' },
    intent: { summary: 'Update file', requestedBy: 'identity:human:alexa', evidenceRefs: [] },
    privacy: { secretValuesAllowed: false, payloadMode: 'refs-hashes-and-metadata-only' },
  };
  assert.deepEqual(validateOperationEnvelope(envelope), ['claimRef is required for mutation authority classes']);
  envelope.claimRef = 'claim_example';
  assert.deepEqual(validateOperationEnvelope(envelope), []);
});

test('doctor reports healthy state and public status omits target refs', () => {
  const idFactory = ids();
  const session = register(createEmptyState(), 'agent-instance-4', 'claude', '2026-09-02T00:00:00Z', idFactory);
  const claimed = requestClaim(session.state, {
    sessionId: session.session.id,
    connectorId: 'github', targetRef: 'private-repo@private-branch:private-path', mode: 'write', operation: 'file.update', idempotencyKey: 'status',
  }, { now: '2026-09-02T00:00:01Z', idFactory });
  const doctor = doctorState(claimed.state, { now: '2026-09-02T00:00:02Z', idFactory });
  assert.equal(doctor.ok, true);
  const status = publicStatus(claimed.state, { now: '2026-09-02T00:00:02Z', idFactory });
  assert.equal(status.activeClaims[0].connectorId, 'github');
  assert.equal('targetRef' in status.activeClaims[0], false);
});
