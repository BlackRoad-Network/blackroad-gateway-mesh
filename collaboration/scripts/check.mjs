import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeText, validateOperationEnvelope } from '../core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '..');
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${relative(repoRoot, path)}: ${error.message}`);
    return null;
  }
}

function walk(path) {
  const output = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}

const manifest = readJson(join(root, 'manifest.json'));
const topology = readJson(join(root, 'connector-topology.json'));
const policy = readJson(join(root, 'connector-policy.json'));
const example = readJson(join(root, 'examples', 'operation-envelope.json'));
const schemaPaths = walk(join(root, 'schemas')).filter((path) => path.endsWith('.json'));
for (const path of schemaPaths) readJson(path);

if (manifest) {
  const ids = manifest.agents?.map((agent) => agent.id) ?? [];
  if (ids.length !== 6) errors.push(`manifest must define exactly six agents; found ${ids.length}`);
  if (new Set(ids).size !== ids.length) errors.push('manifest agent IDs must be unique');
  const expected = Array.from({ length: 6 }, (_, index) => `agent-instance-${index + 1}`);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) errors.push('manifest agent IDs must be agent-instance-1 through agent-instance-6 in order');
  if (manifest.actorModel?.runtimeDoesNotGrantAuthority !== true) errors.push('runtimeDoesNotGrantAuthority must be true');
  if (manifest.actorModel?.modelDoesNotGrantAuthority !== true) errors.push('modelDoesNotGrantAuthority must be true');
  const events = manifest.eventTypes ?? [];
  if (new Set(events).size !== events.length) errors.push('manifest event types must be unique');
}

if (topology) {
  const planeIds = topology.planes?.map((plane) => plane.id) ?? [];
  if (new Set(planeIds).size !== planeIds.length) errors.push('connector topology plane IDs must be unique');
  for (const plane of topology.planes ?? []) {
    if (!plane.primary) errors.push(`topology plane ${plane.id} has no primary connector`);
    if (!plane.authoritativeFor?.length) errors.push(`topology plane ${plane.id} has no authority scope`);
  }
}

if (policy) {
  const connectorIds = policy.connectors?.map((connector) => connector.id) ?? [];
  if (new Set(connectorIds).size !== connectorIds.length) errors.push('connector policy IDs must be unique');
  for (const connector of policy.connectors ?? []) {
    for (const field of ['resourceKey', 'isolation', 'expectedVersion', 'writeGate', 'conflictAction']) {
      if (!connector[field]) errors.push(`connector policy ${connector.id} is missing ${field}`);
    }
  }
  if (policy.defaults?.mutation?.idempotencyKeyRequired !== true) errors.push('mutation idempotency must be required');
  if (policy.defaults?.mutation?.timeoutResult !== 'TIMEOUT_UNKNOWN') errors.push('timeout result must remain TIMEOUT_UNKNOWN');
  if (policy.defaults?.mutation?.zeroResult !== 'EMPTY_OBSERVATION') errors.push('zero result must remain EMPTY_OBSERVATION');
}

if (example) {
  const envelopeErrors = validateOperationEnvelope(example);
  if (envelopeErrors.length) errors.push(`operation envelope example: ${envelopeErrors.join('; ')}`);
}

for (const path of walk(root)) {
  if (path.includes(`${join('tests', '')}`)) continue;
  try {
    assertSafeText(readFileSync(path, 'utf8'), relative(repoRoot, path));
  } catch (error) {
    errors.push(`${relative(repoRoot, path)}: ${error.message}`);
  }
}

const result = {
  ok: errors.length === 0,
  protocolVersion: manifest?.protocolVersion ?? null,
  agents: manifest?.agents?.length ?? 0,
  eventTypes: manifest?.eventTypes?.length ?? 0,
  connectorPlanes: topology?.planes?.length ?? 0,
  connectorPolicies: policy?.connectors?.length ?? 0,
  schemas: schemaPaths.length,
  errors,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
