import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DurableReconciliationQueue } from '../src/reconciliation.mjs';
import { getConnector, loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';
import { ConnectorRuntime } from '../src/runtime.mjs';
import { AdapterRegistry, defineAdapter, inspectAdapter } from '../src/adapter-sdk.mjs';
import { auditConnectors, diffHealthSnapshots } from '../src/audit.mjs';
import { ReceiptChain } from '../src/receipt-chain.mjs';
import { createReceipt } from '../src/receipt.mjs';
import { digestInput } from '../src/receipt.mjs';
import { EvidenceVerifier } from '../src/evidence.mjs';
import { routeTask, validateRoutingProfiles } from '../src/router.mjs';
import { createMcpAdapter } from '../src/mcp-adapter.mjs';
import { CircuitBreaker, CircuitOpenError, TimeoutError, invokeWithResilience } from '../src/resilience.mjs';
import { getNativeTarget, nativeCoverage, planNativeExit, validateNativeCapabilities } from '../src/native.mjs';
import { describeAppSurface, validateAppSurfaceRegistry } from '../src/apps.mjs';

const AUTH_NOW = '2026-09-09T06:30:00.000Z';
let evidenceNonce = 0;

function trustedVerifier() {
  return new EvidenceVerifier({
    clock: () => AUTH_NOW,
    verifyProof: async (record) => record.proof === `signed:${record.nonce}`
  });
}

function signedEvidence(requirements, { id, operation = 'write', input = {}, sessionId = 'session-1', principal = 'user:alexa' }) {
  return Object.fromEntries(requirements.map((requirement) => {
    const nonce = `nonce-${++evidenceNonce}`;
    return [requirement, {
      requirement,
      principal,
      sessionId,
      targetId: id,
      operation,
      inputSha256: digestInput(input),
      issuer: 'road://identity/test-authority',
      issuedAt: '2026-09-09T06:29:00.000Z',
      expiresAt: '2026-09-09T06:34:00.000Z',
      nonce,
      proof: `signed:${nonce}`
    }];
  }));
}

test('configured runtime persists intent before dispatch and reconciles unknown writes after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'road-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000;
  const queue = new DurableReconciliationQueue({ directory, clock: () => now, graceMs: 10 });
  const input = { target: 'private-target', idempotencyKey: randomUUID() };
  const contextKey = randomUUID();
  let writes = 0;
  const adapters = { slack: { operations: ['write'], execute: async () => {
    const [intent] = await new DurableReconciliationQueue({ directory }).list();
    assert.equal(intent.jobId, contextKey);
    assert.equal(intent.inputSha256, digestInput(input));
    writes += 1;
    throw new Error('provider response lost');
  }, verify: async () => ({ ok: true }) } };
  const denied = await planConnectorAction('slack', 'write');
  const request = { id: 'slack', operation: 'write', input, contextKey, principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
  const runtime = new ConnectorRuntime({ adapters, evidenceVerifier: trustedVerifier(), reconciliationQueue: queue });
  const outcome = await runtime.execute({ ...request, evidence: signedEvidence(denied.requirements, request) });
  assert.equal(outcome.receipt.status, 'unknown');
  assert.equal(outcome.receipt.reconciliation.jobId, contextKey);
  now = 1_010;
  const restored = new DurableReconciliationQueue({ directory, clock: () => now, graceMs: 10 });
  const [reconciled] = await restored.runDue({ adapters, resolveContext: async () => ({ id: 'slack', input }) });
  assert.equal(reconciled.status, 'succeeded');
  // Even fresh approval and a new in-memory verifier cannot replay the same durable context.
  const restartedRuntime = new ConnectorRuntime({ adapters, evidenceVerifier: trustedVerifier(), reconciliationQueue: restored });
  const replay = await restartedRuntime.execute({ ...request, evidence: signedEvidence(denied.requirements, request) });
  assert.equal(replay.receipt.reason, 'reconciliation-reservation-failed');
  assert.equal(writes, 1);
});

test('queue reservation failure prevents provider calls; dry runs need no queue access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'road-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'not-a-directory');
  await writeFile(file, '');
  const queue = new DurableReconciliationQueue({ directory: file });
  const adapters = { slack: { operations: ['write'], execute: () => assert.fail('write reached provider'), verify: () => assert.fail('read-back reached provider') } };
  const runtime = new ConnectorRuntime({ adapters, evidenceVerifier: trustedVerifier(), reconciliationQueue: queue });
  const denied = await planConnectorAction('slack', 'write');
  const request = { id: 'slack', operation: 'write', contextKey: randomUUID(), principal: 'user:alexa', sessionId: 'session-1' };
  const evidence = signedEvidence(denied.requirements, request);
  assert.equal((await runtime.execute({ ...request, evidence })).receipt.status, 'planned');
  const blocked = await runtime.execute({ ...request, evidence, dryRun: false });
  assert.equal(blocked.receipt.reason, 'reconciliation-reservation-failed');
});

test('post-dispatch persistence failure retains result and recoverable intent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'road-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = new DurableReconciliationQueue({ directory });
  queue.settle = async () => { throw new Error('disk unavailable'); };
  const result = { providerRef: 'private-provider-ref' };
  const adapters = { slack: { operations: ['write'], execute: async () => result, verify: async () => ({ ok: true }) } };
  const runtime = new ConnectorRuntime({ adapters, evidenceVerifier: trustedVerifier(), reconciliationQueue: queue });
  const denied = await planConnectorAction('slack', 'write');
  const request = { id: 'slack', operation: 'write', contextKey: randomUUID(), principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
  const outcome = await runtime.execute({ ...request, evidence: signedEvidence(denied.requirements, request) });
  assert.equal(outcome.receipt.status, 'unknown');
  assert.equal(outcome.receipt.reason, 'reconciliation-persistence-error');
  assert.deepEqual(outcome.result, result);
  assert.equal((await queue.list())[0].status, 'pending');
});

test('normal verified outcomes settle durable records without scheduling extra provider reads', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'road-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = new DurableReconciliationQueue({ directory });
  const denied = await planConnectorAction('slack', 'write');
  for (const ok of [true, false]) {
    const adapters = { slack: { operations: ['write'], execute: async () => ({}), verify: async () => ({ ok }) } };
    const runtime = new ConnectorRuntime({ adapters, evidenceVerifier: trustedVerifier(), reconciliationQueue: queue });
    const request = { id: 'slack', operation: 'write', contextKey: randomUUID(), principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
    const outcome = await runtime.execute({ ...request, evidence: signedEvidence(denied.requirements, request) });
    assert.equal(outcome.receipt.status, ok ? 'succeeded' : 'failed');
    assert.equal((await queue.list()).find((job) => job.jobId === request.contextKey).status, outcome.receipt.status);
  }
  assert.deepEqual(await queue.runDue({ adapters: {}, resolveContext: () => assert.fail('terminal job scheduled') }), []);
});

test('contains exactly 65 uniquely classified connectors', async () => {
  const fabric = await loadFabric();
  assert.equal(fabric.connectors.length, 65);
  assert.equal(new Set(fabric.connectors.map(({ id }) => id)).size, 65);
  assert.equal(Object.values(fabric.roles).flat().length, 65);
});

test('records newly connected providers without inventing live health', async () => {
  assert.equal((await getConnector('figma')).state, 'ready');
  assert.equal((await getConnector('outlook-email')).state, 'unverified');
  assert.equal((await getConnector('cloudflare')).state, 'unverified');
});

test('retains the financial and secret boundaries', async () => {
  assert.equal((await getConnector('stripe')).role, 'control');
  assert.equal((await getConnector('1password')).role, 'reference-only');
  assert.ok((await loadFabric()).invariants.includes('secret-values-never-enter-fabric'));
});

test('unknown connectors fail restrictive', async () => {
  assert.deepEqual(await planConnectorAction('surprise-provider', 'read'), {
    allowed: false,
    id: 'surprise-provider',
    operation: 'read',
    reason: 'unknown-connector',
    requirements: [],
    missing: []
  });
});

test('healthy reads are allowed and broken providers are blocked', async () => {
  assert.equal((await planConnectorAction('github', 'read')).allowed, true);
  assert.equal((await planConnectorAction('stripe', 'read')).reason, 'connector-broken');
});

test('discussion writes require complete collaboration evidence', async () => {
  const denied = await planConnectorAction('slack', 'write', {});
  assert.equal(denied.allowed, false);
  assert.ok(denied.missing.includes('explicit-user-approval'));

  const context = { id: 'slack', operation: 'write', inputSha256: digestInput({}), principal: 'user:alexa', sessionId: 'session-1' };
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  assert.equal((await planConnectorAction('slack', 'write', evidence, { verifier: trustedVerifier(), context })).allowed, true);
});

test('caller booleans and incorrectly bound evidence never authorize writes', async () => {
  const denied = await planConnectorAction('slack', 'write');
  const booleans = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  const context = { id: 'slack', operation: 'write', inputSha256: digestInput({}), principal: 'user:alexa', sessionId: 'session-1' };
  assert.equal((await planConnectorAction('slack', 'write', booleans, { verifier: trustedVerifier(), context })).reason, 'invalid-required-evidence');

  const wrongTarget = signedEvidence(denied.requirements, { id: 'github' });
  const plan = await planConnectorAction('slack', 'write', wrongTarget, { verifier: trustedVerifier(), context });
  assert.equal(plan.allowed, false);
  assert.ok(plan.evidenceErrors.every((error) => error.endsWith(':target-mismatch')));

  const wrongPrincipal = signedEvidence(denied.requirements, { id: 'slack', principal: 'user:someone-else' });
  const principalPlan = await planConnectorAction('slack', 'write', wrongPrincipal, { verifier: trustedVerifier(), context });
  assert.equal(principalPlan.allowed, false);
  assert.ok(principalPlan.evidenceErrors.every((error) => error.endsWith(':principal-mismatch')));
});

test('control writes additionally require governance', async () => {
  const plan = await planConnectorAction('railway-api', 'write', {
    'exact-live-session': true,
    'target-ownership': true,
    'exclusive-claim': true,
    'semantic-idempotency': true,
    'provider-authentication': true,
    'read-after-write-verification': true,
    'explicit-user-approval': true
  });
  assert.equal(plan.allowed, false);
  assert.deepEqual(plan.missing, ['governance-evidence']);
});

test('event and reference-only connectors cannot mutate', async () => {
  assert.equal((await planConnectorAction('zoom', 'write')).reason, 'event-connectors-are-read-only');
  assert.equal((await planConnectorAction('1password', 'write')).reason, 'reference-only');
});

test('aliases inherit provider observations without losing their contract identity', async () => {
  const railway = await getConnector('railway-cloud');
  assert.equal(railway.id, 'railway-cloud');
  assert.equal(railway.observedVia, 'railway-api');
  assert.equal(railway.state, 'ready');
});

test('all contracts expose role-derived operations and semantics', async () => {
  const fabric = await loadFabric();
  assert.ok(fabric.connectors.every(({ capabilities }) => Array.isArray(capabilities.operations) && Array.isArray(capabilities.semantics)));
  assert.deepEqual((await getConnector('zoom')).capabilities.operations, ['read']);
  assert.deepEqual((await getConnector('1password')).capabilities.operations, []);
});

test('runtime defaults to dry-run and never invokes the adapter', async () => {
  let calls = 0;
  const runtime = new ConnectorRuntime({ adapters: { github: { execute: async () => { calls += 1; } } } });
  const outcome = await runtime.execute({ id: 'github', operation: 'read', input: { query: 'road' } });
  assert.equal(outcome.receipt.status, 'planned');
  assert.equal(calls, 0);
});

test('blocked providers never reach their adapters', async () => {
  let calls = 0;
  const runtime = new ConnectorRuntime({ adapters: { stripe: { execute: async () => { calls += 1; } } } });
  const outcome = await runtime.execute({ id: 'stripe', operation: 'read', dryRun: false });
  assert.equal(outcome.receipt.status, 'blocked');
  assert.equal(calls, 0);
});

test('verified writes produce input-safe receipts', async () => {
  const input = { channel: 'internal', token: 'never-copy-this', text: 'private message' };
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack', input });
  const runtime = new ConnectorRuntime({
    clock: () => AUTH_NOW,
    evidenceVerifier: trustedVerifier(),
    adapters: {
      slack: {
        operations: ['write'],
        execute: async () => ({ providerId: 'message-1' }),
        verify: async () => ({ ok: true, detail: 'provider object read back' })
      }
    }
  });
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', input, evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false });
  assert.equal(outcome.receipt.status, 'succeeded');
  assert.equal(outcome.receipt.inputSha256.length, 64);
  assert.ok(!JSON.stringify(outcome.receipt).includes(input.token));
  assert.ok(!JSON.stringify(outcome.receipt).includes(input.text));
});

test('write adapters without verification are rejected before execution', () => {
  let calls = 0;
  assert.throws(() => new ConnectorRuntime({
    adapters: { slack: { operations: ['write'], execute: async () => { calls += 1; } } }
  }), /must implement read-after-write verification/);
  assert.equal(calls, 0);
});

test('negative read-after-write verification is a failed receipt', async () => {
  const adapter = {
    operations: ['write'],
    execute: async () => ({ providerId: 'message-1' }),
    verify: async () => ({ ok: false, detail: 'token=provider-secret provider object not found' })
  };
  const runtime = new ConnectorRuntime({ adapters: { slack: adapter }, evidenceVerifier: trustedVerifier(), clock: () => AUTH_NOW });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false });
  assert.equal(outcome.receipt.status, 'failed');
  assert.equal(outcome.receipt.reason, 'read-after-write-verification-failed');
  assert.deepEqual(outcome.receipt.verification, { ok: false, detail: 'token=[REDACTED] provider object not found' });
  assert.ok(!JSON.stringify(outcome.receipt).includes('provider-secret'));
});

test('consumed write evidence cannot be replayed', async () => {
  let calls = 0;
  const verifier = trustedVerifier();
  const runtime = new ConnectorRuntime({
    clock: () => AUTH_NOW,
    evidenceVerifier: verifier,
    adapters: {
      slack: {
        operations: ['write'],
        execute: async () => ({ providerId: `message-${++calls}` }),
        verify: async () => ({ ok: true })
      }
    }
  });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  const request = { id: 'slack', operation: 'write', evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
  assert.equal((await runtime.execute(request)).receipt.status, 'succeeded');
  const replay = await runtime.execute(request);
  assert.equal(replay.receipt.status, 'blocked');
  assert.equal(replay.plan.reason, 'invalid-required-evidence');
  assert.equal(calls, 1);
});

test('concurrent replay attempts reserve evidence atomically', async () => {
  let releaseProof;
  const proofGate = new Promise((resolve) => { releaseProof = resolve; });
  const verifier = new EvidenceVerifier({ clock: () => AUTH_NOW, verifyProof: async () => { await proofGate; return true; } });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  const context = { id: 'slack', operation: 'write', inputSha256: digestInput({}), principal: 'user:alexa', sessionId: 'session-1' };
  const first = verifier.verify(denied.requirements, evidence, context, { consume: true });
  const second = verifier.verify(denied.requirements, evidence, context, { consume: true });
  releaseProof();
  assert.equal((await first).valid, true);
  const rejected = await second;
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.every((error) => error.endsWith(':replayed')));
});

test('probe failures expose an error class but not provider error contents', async () => {
  const runtime = new ConnectorRuntime({ adapters: { github: { execute: async () => ({}), probe: async () => { throw new Error('token=secret'); } } } });
  const probe = await runtime.probe('github');
  assert.equal(probe.reachable, false);
  assert.equal(probe.detail, 'Error');
  assert.ok(!JSON.stringify(probe).includes('secret'));
});

test('adapter SDK enforces write verification and duplicate ownership', () => {
  assert.throws(() => defineAdapter({ id: 'slack', operations: ['write'], execute: async () => {} }), /must implement/);
  const adapter = defineAdapter({
    id: 'slack',
    operations: ['read', 'write'],
    execute: async () => ({}),
    verify: async () => ({ ok: true })
  });
  const registry = new AdapterRegistry([adapter]);
  assert.throws(() => registry.register('slack', adapter), /already registered/);
  assert.deepEqual(registry.list(), ['slack']);
});

test('adapter identity cannot be rebound through object, map, or direct registration', () => {
  const adapter = defineAdapter({ id: 'github', execute: async () => ({}) });
  assert.throws(() => new AdapterRegistry({ slack: adapter }), /adapter id must match registry key/);
  assert.throws(() => new AdapterRegistry(new Map([['slack', adapter]])), /adapter id must match registry key/);
  assert.throws(() => new AdapterRegistry().register('slack', adapter), /adapter id must match registry key/);
  assert.deepEqual(new AdapterRegistry({ github: adapter }).list(), ['github']);
  assert.deepEqual(new AdapterRegistry({ github: { execute: async () => ({}) } }).list(), ['github']);
});

test('invalid timeout values cannot start provider calls or change the circuit', async () => {
  for (const operation of ['read', 'write']) {
    for (const timeoutMs of [0, -1, NaN, Infinity, -Infinity, '100', null]) {
      let calls = 0;
      const breaker = new CircuitBreaker({ failureThreshold: 1 });
      await assert.rejects(invokeWithResilience({
        key: 'invalid-timeout', operation, timeoutMs, breaker,
        invoke: async () => { calls += 1; return {}; }
      }), RangeError);
      assert.equal(calls, 0, `${operation}: timeout ${timeoutMs} started a provider call`);
      assert.equal(breaker.state('invalid-timeout'), 'closed');
    }
  }
});

test('ambiguous writes require reconciliation and keep approval consumed', async () => {
  for (const phase of ['execute', 'verify']) {
    let writes = 0;
    const result = { providerId: 'message-ambiguous' };
    const runtime = new ConnectorRuntime({
      evidenceVerifier: trustedVerifier(), clock: () => AUTH_NOW,
      adapters: { slack: {
        operations: ['write'],
        execute: async () => {
          writes += 1;
          if (phase === 'execute') throw new TimeoutError('token=must-not-leak');
          return result;
        },
        verify: async () => { throw new Error('token=must-not-leak'); }
      } }
    });
    const denied = await planConnectorAction('slack', 'write');
    const evidence = signedEvidence(denied.requirements, { id: 'slack' });
    const request = { id: 'slack', operation: 'write', evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
    const outcome = await runtime.execute(request);
    assert.equal(outcome.receipt.status, 'unknown');
    assert.equal(outcome.receipt.reason, phase === 'execute' ? 'write-outcome-unknown' : 'read-after-write-verification-error');
    assert.deepEqual(outcome.receipt.reconciliation, { required: true, automaticRetry: false });
    assert.equal(outcome.result, phase === 'verify' ? result : undefined);
    assert.ok(!JSON.stringify(outcome.receipt).includes('must-not-leak'));
    assert.equal((await runtime.execute(request)).receipt.status, 'blocked');
    assert.equal(writes, 1);
  }
});

test('read execution errors remain failed without write reconciliation', async () => {
  const runtime = new ConnectorRuntime({ adapters: { github: {
    execute: async () => { throw new Error('token=must-not-leak'); }
  } } });
  const outcome = await runtime.execute({ id: 'github', operation: 'read', dryRun: false });
  assert.equal(outcome.receipt.status, 'failed');
  assert.equal(outcome.receipt.reason, 'adapter-execution-failed');
  assert.equal(outcome.receipt.reconciliation, undefined);
  assert.ok(!JSON.stringify(outcome.receipt).includes('must-not-leak'));
});

test('a provider write can complete after timeout without being invoked again', async () => {
  let writes = 0;
  let release;
  let committed = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = createMcpAdapter({
    id: 'slack', operations: ['write'], resilience: { timeoutMs: 5, attempts: 3 },
    actions: { write: { tool: 'slack.write' }, verify: { tool: 'slack.verify' } },
    invoke: async (tool) => {
      if (tool === 'slack.verify') return { ok: committed };
      writes += 1;
      await gate;
      committed = true;
      return { providerId: 'late-message' };
    }
  });
  const runtime = new ConnectorRuntime({ adapters: [adapter], evidenceVerifier: trustedVerifier(), clock: () => AUTH_NOW });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  const request = { id: 'slack', operation: 'write', evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false };
  const outcome = await runtime.execute(request);
  assert.equal(outcome.receipt.status, 'unknown');
  assert.equal(outcome.receipt.verification.detail, 'TimeoutError');
  release();
  await gate;
  assert.equal(committed, true);
  assert.equal((await runtime.execute(request)).receipt.status, 'blocked');
  assert.equal(writes, 1);
  // A separate read-back establishes provider state without repeating the write.
  assert.equal((await adapter.verify({ input: {} })).ok, true);
  assert.equal(writes, 1);
});

test('adapter inspection rejects capabilities beyond the connector role', async () => {
  const zoom = await getConnector('zoom');
  const result = inspectAdapter({ operations: ['write'], execute: async () => {}, verify: async () => ({ ok: true }) }, zoom);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('operation-exceeds-contract'));
});

test('provider aliases resolve one registered adapter for multiple contracts', async () => {
  const adapter = defineAdapter({ id: 'railway-api', execute: async () => ({ projects: [] }) });
  const runtime = new ConnectorRuntime({ adapters: new AdapterRegistry([adapter]) });
  const outcome = await runtime.execute({ id: 'railway-cloud', operation: 'read', dryRun: false });
  assert.equal(outcome.receipt.status, 'succeeded');
});

test('runtime refuses operations omitted from an adapter declaration', async () => {
  let calls = 0;
  const adapter = defineAdapter({ id: 'slack', operations: ['read'], execute: async () => { calls += 1; } });
  const runtime = new ConnectorRuntime({ adapters: [adapter], evidenceVerifier: trustedVerifier(), clock: () => AUTH_NOW });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = signedEvidence(denied.requirements, { id: 'slack' });
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', evidence, principal: 'user:alexa', sessionId: 'session-1', dryRun: false });
  assert.equal(outcome.receipt.reason, 'adapter-operation-not-supported');
  assert.equal(calls, 0);
});

test('fleet audit respects its concurrency bound and canonical input order', async () => {
  let active = 0;
  let maximum = 0;
  const runtime = {
    async probe(id) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { id, reachable: true, state: 'ready' };
    }
  };
  const ids = ['slack', 'github', 'linear', 'notion', 'airtable'];
  const snapshot = await auditConnectors({ runtime, ids, concurrency: 2, clock: () => '2026-09-08T10:00:00.000Z' });
  assert.equal(maximum, 2);
  assert.deepEqual(snapshot.results.map(({ id }) => id), ids);
  assert.equal(snapshot.healthy, 5);
});

test('health diffs distinguish recovery and degradation', () => {
  const before = { checkedAt: 'before', results: [
    { id: 'stripe', state: 'broken', reachable: false },
    { id: 'github', state: 'ready', reachable: true }
  ] };
  const after = { checkedAt: 'after', results: [
    { id: 'stripe', state: 'ready', reachable: true },
    { id: 'github', state: 'broken', reachable: false }
  ] };
  const diff = diffHealthSnapshots(before, after);
  assert.equal(diff.recovered, 1);
  assert.equal(diff.degraded, 1);
  assert.equal(diff.changed, 2);
});

test('receipt chain verifies intact history and detects tampering', () => {
  const chain = new ReceiptChain();
  const first = createReceipt({ id: 'github', operation: 'read', status: 'succeeded', timestamp: '2026-09-08T10:00:00.000Z' });
  const second = createReceipt({ id: 'slack', operation: 'write', status: 'planned', reason: 'dry-run', timestamp: '2026-09-08T10:01:00.000Z' });
  chain.append(first);
  chain.append(second);
  const checkpoint = chain.checkpoint();
  assert.equal(chain.verify().valid, true);

  const tampered = chain.entries();
  tampered[1] = { ...tampered[1], receipt: { ...tampered[1].receipt, status: 'succeeded' } };
  assert.deepEqual(chain.verify(tampered), { valid: false, length: 2, errorAt: 1 });

  const truncated = chain.entries().slice(0, 1);
  assert.deepEqual(chain.verify(truncated, checkpoint), {
    valid: false,
    length: 1,
    errorAt: 1,
    reason: 'checkpoint-mismatch'
  });
});

test('billing never substitutes another connector for broken Stripe', async () => {
  const route = await routeTask({ task: 'billing', operation: 'read' });
  assert.equal(route.allowed, false);
  assert.equal(route.reason, 'authoritative-connector-unavailable');
  assert.deepEqual(route.alternatives, []);
  assert.deepEqual(route.unavailable, [{ id: 'stripe', state: 'broken' }]);
});

test('all semantic routes reference compatible canonical connectors', async () => {
  const validation = await validateRoutingProfiles();
  assert.deepEqual(validation, { valid: true, profiles: 13, connectorReferences: 42, errors: [] });
});

test('maps every bridge into exactly one of the eight RoadOS surfaces', async () => {
  assert.deepEqual(await validateNativeCapabilities(), {
    valid: true,
    surfaces: 8,
    capabilities: 53,
    bridges: 65,
    errors: []
  });
  const coverage = await nativeCoverage();
  assert.equal(coverage.bridges, 65);
  assert.equal(coverage.states.verified, 1);
  assert.equal(coverage.states.contracted, 52);
});

test('maps every currently surfaced app family into owned RoadOS capability space', async () => {
  assert.deepEqual(await validateAppSurfaceRegistry(), { valid: true, apps: 68, errors: [] });
  assert.equal((await describeAppSurface('outlook-email')).nativeCapability.id, 'email');
  assert.equal((await describeAppSurface('github')).nativeCapability.id, 'source');
  assert.equal((await describeAppSurface('malwarebytes')).nativeCapability.id, 'security');
});

test('does not relabel an external provider as a native capability', async () => {
  const fabric = await loadFabric();
  const externalIds = new Set(fabric.connectors.map(({ id }) => id));
  const targets = await Promise.all(fabric.connectors.map(({ id }) => getNativeTarget(id)));
  assert.ok(targets.every(({ capability }) => !externalIds.has(capability.id)));
});

test('external providers are bridges to literal native capabilities', async () => {
  const outlook = await getNativeTarget('outlook-email');
  assert.equal(outlook.capability.surface, 'chat');
  assert.equal(outlook.capability.id, 'email');
  assert.equal(outlook.relationship, 'bridge-until-native-exit-gate-passes');

  const figma = await getNativeTarget('figma');
  assert.equal(figma.capability.surface, 'design');
  assert.equal(figma.capability.id, 'design-system');
});

test('native preference is blocked until implementation and exit evidence are verified', async () => {
  const outlook = await planNativeExit('outlook-email', {});
  assert.equal(outlook.ready, false);
  assert.equal(outlook.reason, 'native-capability-not-verified');
  assert.ok(outlook.missing.includes('owned-storage'));
  assert.ok(outlook.missing.includes('local-read'));
  assert.ok(outlook.missing.includes('local-write'));

  const analytics = await planNativeExit('amplitude', {});
  assert.ok(analytics.requirements.includes('local-read'));
  assert.ok(!analytics.requirements.includes('local-write'));
});

test('verified native capability still requires fresh exit evidence', async () => {
  const plan = await planNativeExit('adapter-plane', {});
  assert.equal(plan.nativeState, 'verified');
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'missing-exit-evidence');

  const evidence = Object.fromEntries(plan.requirements.map((requirement) => [requirement, true]));
  const ready = await planNativeExit('adapter-plane', evidence);
  assert.equal(ready.ready, true);
  assert.equal(ready.reason, null);
});

test('equivalent writes require explicit healthy provider selection', async () => {
  const undecided = await routeTask({ task: 'email-delivery', operation: 'write' });
  assert.equal(undecided.allowed, false);
  assert.equal(undecided.reason, 'explicit-provider-selection-required');
  assert.deepEqual(undecided.alternatives, ['gmail', 'resend']);

  const selected = await routeTask({ task: 'email-delivery', operation: 'write', preferred: 'gmail' });
  assert.equal(selected.allowed, true);
  assert.equal(selected.selected, 'gmail');
  assert.equal(selected.requiresExplicitSelection, true);
});

test('unhealthy preferred connector does not trigger silent write failover', async () => {
  const route = await routeTask({ task: 'analytics', operation: 'write', preferred: 'amplitude' });
  assert.equal(route.reason, 'operation-not-supported');
  const meeting = await routeTask({ task: 'collaborative-work', operation: 'write', preferred: 'surprise-provider' });
  assert.equal(meeting.allowed, false);
  assert.equal(meeting.reason, 'preferred-connector-unavailable');
  assert.equal(meeting.selected, null);
});

test('reference-only routing cannot execute secret access', async () => {
  const route = await routeTask({ task: 'secrets', operation: 'read' });
  assert.equal(route.allowed, false);
  assert.equal(route.reason, 'reference-only');
});

test('resilience retries transient reads and returns the successful value', async () => {
  let calls = 0;
  const value = await invokeWithResilience({
    key: 'github:read',
    operation: 'read',
    attempts: 3,
    timeoutMs: 100,
    invoke: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('temporary'), { transient: true });
      return { ok: true };
    }
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 3);
});

test('resilience never automatically retries writes', async () => {
  let calls = 0;
  await assert.rejects(invokeWithResilience({
    key: 'gmail:write',
    operation: 'write',
    attempts: 5,
    timeoutMs: 100,
    invoke: async () => {
      calls += 1;
      throw Object.assign(new Error('temporary'), { transient: true });
    }
  }), /temporary/);
  assert.equal(calls, 1);
});

test('timeouts are transient and circuit breaker opens at its threshold', async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, clock: () => now });
  const never = () => new Promise(() => {});
  await assert.rejects(invokeWithResilience({ key: 'slow', operation: 'read', attempts: 1, timeoutMs: 5, breaker, invoke: never }), TimeoutError);
  await assert.rejects(invokeWithResilience({ key: 'slow', operation: 'read', attempts: 1, timeoutMs: 5, breaker, invoke: never }), TimeoutError);
  assert.equal(breaker.state('slow'), 'open');
  await assert.rejects(invokeWithResilience({ key: 'slow', operation: 'read', breaker, invoke: async () => ({}) }), CircuitOpenError);
  now = 1000;
  assert.equal(await invokeWithResilience({ key: 'slow', operation: 'read', attempts: 1, timeoutMs: 20, breaker, invoke: async () => 'recovered' }), 'recovered');
  assert.equal(breaker.state('slow'), 'closed');
});

test('MCP adapter maps tools and verifies writes through a read operation', async () => {
  const calls = [];
  const adapter = createMcpAdapter({
    id: 'gmail',
    operations: ['read', 'write'],
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'gmail.verify') return { ok: true, detail: 'message read back' };
      return { id: 'provider-message-1' };
    },
    actions: {
      read: { tool: 'gmail.read' },
      write: { tool: 'gmail.send' },
      verify: { tool: 'gmail.verify', buildArguments: ({ result }) => ({ id: result.id }) }
    }
  });
  const result = await adapter.execute({ operation: 'write', input: { to: 'owner' } });
  const verified = await adapter.verify({ operation: 'write', input: {}, result });
  assert.deepEqual(calls.map(({ tool }) => tool), ['gmail.send', 'gmail.verify']);
  assert.deepEqual(calls[1].args, { id: 'provider-message-1' });
  assert.deepEqual(verified, { ok: true, detail: 'message read back' });
});
