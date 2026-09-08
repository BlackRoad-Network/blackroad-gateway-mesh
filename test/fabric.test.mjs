import assert from 'node:assert/strict';
import test from 'node:test';
import { getConnector, loadFabric } from '../src/catalog.mjs';
import { planConnectorAction } from '../src/planner.mjs';

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
