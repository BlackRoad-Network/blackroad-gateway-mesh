import { readFile } from 'node:fs/promises';
import { loadFabric } from './catalog.mjs';

const routesUrl = new URL('../data/routing-profiles.json', import.meta.url);
const EXECUTABLE = new Set(['ready', 'ready-empty', 'limited']);

export async function loadRoutingProfiles() {
  return JSON.parse(await readFile(routesUrl, 'utf8'));
}

export async function validateRoutingProfiles() {
  const [routing, fabric] = await Promise.all([loadRoutingProfiles(), loadFabric()]);
  const byId = new Map(fabric.connectors.map((connector) => [connector.id, connector]));
  const errors = [];
  let connectorReferences = 0;

  for (const [task, profile] of Object.entries(routing.profiles)) {
    if (!['equivalent-outcome', 'source-of-truth', 'reference-only'].includes(profile.authority)) errors.push(`${task}: invalid authority`);
    if (profile.authority === 'source-of-truth' && profile.connectors.length !== 1) errors.push(`${task}: source-of-truth must name exactly one connector`);
    if (new Set(profile.connectors).size !== profile.connectors.length) errors.push(`${task}: duplicate connector`);
    for (const id of profile.connectors) {
      connectorReferences += 1;
      const connector = byId.get(id);
      if (!connector) {
        errors.push(`${task}: unknown connector ${id}`);
        continue;
      }
      if (profile.authority !== 'reference-only' && profile.operations.some((operation) => !connector.capabilities.operations.includes(operation))) {
        errors.push(`${task}: ${id} does not support every declared operation`);
      }
      if (profile.authority === 'reference-only' && connector.role !== 'reference-only') errors.push(`${task}: ${id} is not reference-only`);
    }
  }
  return Object.freeze({ valid: errors.length === 0, profiles: Object.keys(routing.profiles).length, connectorReferences, errors });
}

export async function routeTask({ task, operation = 'read', preferred = null }) {
  const [routing, fabric] = await Promise.all([loadRoutingProfiles(), loadFabric()]);
  const profile = routing.profiles[task];
  if (!profile) return blocked(task, operation, 'unknown-task');
  if (!profile.operations.includes(operation)) return blocked(task, operation, 'operation-not-supported');

  const byId = new Map(fabric.connectors.map((connector) => [connector.id, connector]));
  const considered = profile.connectors.map((id) => byId.get(id));
  const available = considered.filter((connector) => connector && EXECUTABLE.has(connector.state) && connector.capabilities.operations.includes(operation));
  const unavailable = considered.filter((connector) => !available.includes(connector)).map(({ id, state }) => ({ id, state }));

  if (profile.authority === 'reference-only') {
    return { allowed: false, task, operation, authority: profile.authority, selected: null, alternatives: [], unavailable, reason: 'reference-only' };
  }
  if (profile.authority === 'source-of-truth') {
    const selected = available[0]?.id ?? null;
    return selected
      ? { allowed: true, task, operation, authority: profile.authority, selected, alternatives: [], unavailable, requiresExplicitSelection: false, reason: null }
      : { allowed: false, task, operation, authority: profile.authority, selected: null, alternatives: [], unavailable, requiresExplicitSelection: false, reason: 'authoritative-connector-unavailable' };
  }
  if (!available.length) {
    return { allowed: false, task, operation, authority: profile.authority, selected: null, alternatives: [], unavailable, requiresExplicitSelection: operation === 'write', reason: 'no-connector-available' };
  }

  const preferredConnector = preferred ? available.find(({ id }) => id === preferred) : null;
  const alternatives = available.filter(({ id }) => id !== preferredConnector?.id).map(({ id }) => id);
  if (operation === 'write' && !preferredConnector) {
    return {
      allowed: false,
      task,
      operation,
      authority: profile.authority,
      selected: null,
      alternatives: available.map(({ id }) => id),
      unavailable,
      requiresExplicitSelection: true,
      reason: preferred ? 'preferred-connector-unavailable' : 'explicit-provider-selection-required'
    };
  }
  return {
    allowed: true,
    task,
    operation,
    authority: profile.authority,
    selected: preferredConnector?.id ?? available[0].id,
    alternatives,
    unavailable,
    requiresExplicitSelection: operation === 'write',
    reason: null
  };
}

function blocked(task, operation, reason) {
  return { allowed: false, task, operation, selected: null, alternatives: [], unavailable: [], reason };
}
