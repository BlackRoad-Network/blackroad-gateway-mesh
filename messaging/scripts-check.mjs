import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function json(name) {
  return JSON.parse(await readFile(join(here, name), 'utf8'));
}

for (const required of [
  'core.mjs',
  'store.mjs',
  'provider-plan.mjs',
  'provider-policy.json',
  'provider-capabilities.json',
  'provider-surfaces.observed.json',
  'surface-resolver.mjs',
  'surface-aware-plan.mjs',
  'schemas/provider-surface.schema.json',
  'tests/surface.test.mjs',
]) {
  await access(join(here, required));
}

const pkg = await json('package.json');
const capabilities = await json('provider-capabilities.json');
const policies = await json('provider-policy.json');
const surfaces = await json('provider-surfaces.observed.json');
const surfaceSchema = await json('schemas/provider-surface.schema.json');

assert.equal(pkg.type, 'module');
assert.ok(pkg.scripts?.test);
assert.ok(pkg.scripts?.verify);
assert.equal(capabilities.schema, 'road-messaging-provider-capabilities-v1');
assert.equal(policies.schema, 'road-messaging-provider-policy-v1');
assert.equal(surfaces.schema, 'road-messaging-provider-surfaces-v1');
assert.match(surfaceSchema.$id, /^road:\/\//);

const providerIds = Object.keys(capabilities.providers ?? {}).sort();
const policyIds = Object.keys(policies.providers ?? {}).sort();
const observedIds = Object.keys(surfaces.providers ?? {}).sort();

assert.ok(providerIds.length >= 10, 'expected a multi-provider capability catalog');
assert.deepEqual(policyIds, providerIds, 'every capability provider needs a policy');
assert.ok(observedIds.every((id) => providerIds.includes(id)), 'observed providers must exist in the protocol catalog');

const writable = observedIds.filter((id) => surfaces.providers[id].mode === 'READ_WRITE_DISCUSSION');
const readOnly = observedIds.filter((id) => surfaces.providers[id].mode === 'READ_ONLY_DISCUSSION');
const adapterOnly = observedIds.filter((id) => surfaces.providers[id].mode === 'ADAPTER_PLAN_ONLY');

assert.ok(writable.includes('slack'), 'Slack must preserve its verified write surface');
assert.ok(writable.includes('github'), 'GitHub must preserve its verified write surface');
assert.equal(surfaces.providers['microsoft-teams']?.connectionState, 'NOT_CONNECTED');
assert.equal(surfaces.providers['microsoft-teams']?.write?.available, false);

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolProviders: providerIds.length,
  observedProviders: observedIds.length,
  writableProviders: writable,
  readOnlyProviders: readOnly,
  adapterOnlyProviders: adapterOnly,
  teamsState: surfaces.providers['microsoft-teams']?.connectionState,
}, null, 2)}\n`);
