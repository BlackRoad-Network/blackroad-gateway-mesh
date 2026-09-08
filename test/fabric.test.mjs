import assert from 'node:assert/strict';
import test from 'node:test';
import { getConnector, loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';
import { ConnectorRuntime } from '../src/runtime.mjs';

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
