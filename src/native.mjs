import { readFile } from 'node:fs/promises';
import { loadFabric } from './catalog.mjs';

const nativeUrl = new URL('../data/native-capabilities.json', import.meta.url);
const SURFACES = ['search', 'chat', 'code', 'work', 'play', 'design', 'integrate', 'collaborate'];
const STATES = new Set(['contracted', 'scaffolded', 'usable', 'verified', 'native-preferred']);
const OPERATIONS = new Set(['read', 'write']);

export async function loadNativeCapabilities() {
  return JSON.parse(await readFile(nativeUrl, 'utf8'));
}

export async function validateNativeCapabilities() {
  const [native, fabric] = await Promise.all([loadNativeCapabilities(), loadFabric()]);
  const errors = [];
  const listed = [];

  if (JSON.stringify(Object.keys(native.surfaces)) !== JSON.stringify(SURFACES)) {
    errors.push('surfaces must be the canonical eight in order');
  }

  for (const [surface, ids] of Object.entries(native.surfaces)) {
    for (const id of ids) {
      listed.push(id);
      const capability = native.capabilities[id];
      if (!capability) {
        errors.push(`${surface}: unknown capability ${id}`);
        continue;
      }
      if (capability.surface !== surface) errors.push(`${id}: surface mismatch`);
      if (!STATES.has(capability.state)) errors.push(`${id}: invalid state`);
      if (!Array.isArray(capability.operations) || capability.operations.length === 0) errors.push(`${id}: operations required`);
      if (capability.operations?.some((operation) => !OPERATIONS.has(operation))) errors.push(`${id}: invalid operation`);
    }
  }

  if (new Set(listed).size !== listed.length) errors.push('capabilities must be listed once');
  const defined = Object.keys(native.capabilities);
  for (const id of defined) if (!listed.includes(id)) errors.push(`${id}: capability is not assigned to a surface`);

  const connectorIds = new Set(fabric.connectors.map(({ id }) => id));
  for (const id of connectorIds) {
    if (!native.bridges[id]) errors.push(`${id}: native destination missing`);
  }
  for (const [id, capability] of Object.entries(native.bridges)) {
    if (!connectorIds.has(id)) errors.push(`${id}: unknown external bridge`);
    if (!native.capabilities[capability]) errors.push(`${id}: unknown native destination ${capability}`);
  }

  return Object.freeze({
    valid: errors.length === 0,
    surfaces: Object.keys(native.surfaces).length,
    capabilities: defined.length,
    bridges: Object.keys(native.bridges).length,
    errors
  });
}

export async function getNativeTarget(connectorId) {
  const [native, fabric] = await Promise.all([loadNativeCapabilities(), loadFabric()]);
  const connector = fabric.connectors.find(({ id }) => id === connectorId);
  const capabilityId = native.bridges[connectorId];
  if (!connector || !capabilityId) return null;
  return {
    connector: { id: connector.id, role: connector.role, state: connector.state },
    capability: { id: capabilityId, ...native.capabilities[capabilityId] },
    relationship: 'bridge-until-native-exit-gate-passes'
  };
}

export async function nativeCoverage() {
  const native = await loadNativeCapabilities();
  const states = Object.values(native.capabilities).reduce((counts, capability) => {
    counts[capability.state] = (counts[capability.state] ?? 0) + 1;
    return counts;
  }, {});
  return {
    version: native.version,
    surfaces: Object.keys(native.surfaces).length,
    capabilities: Object.keys(native.capabilities).length,
    bridges: Object.keys(native.bridges).length,
    states
  };
}

export async function planNativeExit(connectorId, evidence = {}) {
  const [native, target] = await Promise.all([loadNativeCapabilities(), getNativeTarget(connectorId)]);
  if (!target) return { ready: false, connectorId, reason: 'unknown-bridge', requirements: [], missing: [] };

  const requirements = [...native.exitGate.baseRequirements];
  for (const operation of target.capability.operations) {
    requirements.push(native.exitGate.operationRequirements[operation]);
  }
  const uniqueRequirements = [...new Set(requirements)];
  const missing = uniqueRequirements.filter((requirement) => evidence[requirement] !== true);
  const stateEligible = ['verified', 'native-preferred'].includes(target.capability.state);

  return {
    ready: stateEligible && missing.length === 0,
    connectorId,
    nativeCapability: target.capability.id,
    surface: target.capability.surface,
    nativeState: target.capability.state,
    requirements: uniqueRequirements,
    missing,
    reason: !stateEligible ? 'native-capability-not-verified' : missing.length ? 'missing-exit-evidence' : null
  };
}
