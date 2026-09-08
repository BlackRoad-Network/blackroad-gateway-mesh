import assert from 'node:assert/strict';
import test from 'node:test';
import { getConnector, loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';
import { ConnectorRuntime } from '../src/runtime.mjs';
import { AdapterRegistry, defineAdapter, inspectAdapter } from '../src/adapter-sdk.mjs';
import { auditConnectors, diffHealthSnapshots } from '../src/audit.mjs';
import { ReceiptChain } from '../src/receipt-chain.mjs';
import { createReceipt } from '../src/receipt.mjs';
import { routeTask, validateRoutingProfiles } from '../src/router.mjs';
import { createMcpAdapter } from '../src/mcp-adapter.mjs';
import { CircuitBreaker, CircuitOpenError, TimeoutError, invokeWithResilience } from '../src/resilience.mjs';

test('contains exactly 62 uniquely classified connectors', async () => {
  const fabric = await loadFabric();
  assert.equal(fabric.connectors.length, 62);
  assert.equal(new Set(fabric.connectors.map(({ id }) => id)).size, 62);
  assert.equal(Object.values(fabric.roles).flat().length, 62);
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

  const evidence = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  assert.equal((await planConnectorAction('slack', 'write', evidence)).allowed, true);
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
  const runtime = new ConnectorRuntime({
    clock: () => '2026-09-08T09:00:00.000Z',
    adapters: {
      slack: {
        execute: async () => ({ providerId: 'message-1' }),
        verify: async () => ({ ok: true, detail: 'provider object read back' })
      }
    }
  });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  const input = { channel: 'internal', token: 'never-copy-this', text: 'private message' };
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', input, evidence, dryRun: false });
  assert.equal(outcome.receipt.status, 'succeeded');
  assert.equal(outcome.receipt.inputSha256.length, 64);
  assert.ok(!JSON.stringify(outcome.receipt).includes(input.token));
  assert.ok(!JSON.stringify(outcome.receipt).includes(input.text));
});

test('writes cannot succeed without read-after-write verification', async () => {
  const adapter = { execute: async () => ({ providerId: 'message-1' }) };
  const runtime = new ConnectorRuntime({ adapters: { slack: adapter } });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', evidence, dryRun: false });
  assert.equal(outcome.receipt.status, 'failed');
  assert.equal(outcome.receipt.reason, 'verification-not-implemented');
});

test('negative read-after-write verification is a failed receipt', async () => {
  const adapter = {
    execute: async () => ({ providerId: 'message-1' }),
    verify: async () => ({ ok: false, detail: 'provider object not found' })
  };
  const runtime = new ConnectorRuntime({ adapters: { slack: adapter } });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', evidence, dryRun: false });
  assert.equal(outcome.receipt.status, 'failed');
  assert.equal(outcome.receipt.reason, 'read-after-write-verification-failed');
  assert.deepEqual(outcome.receipt.verification, { ok: false, detail: 'provider object not found' });
});

test('probe failures expose an error class but not provider error contents', async () => {
  const runtime = new ConnectorRuntime({ adapters: { github: { probe: async () => { throw new Error('token=secret'); } } } });
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
  const runtime = new ConnectorRuntime({ adapters: [adapter] });
  const denied = await planConnectorAction('slack', 'write');
  const evidence = Object.fromEntries(denied.requirements.map((requirement) => [requirement, true]));
  const outcome = await runtime.execute({ id: 'slack', operation: 'write', evidence, dryRun: false });
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
  assert.deepEqual(validation, { valid: true, profiles: 12, connectorReferences: 37, errors: [] });
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
