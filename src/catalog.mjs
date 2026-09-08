import { readFile } from 'node:fs/promises';

const catalogUrl = new URL('../data/connector-fabric.json', import.meta.url);
const VALID_ROLES = new Set(['discussion', 'delivery', 'event', 'control', 'decision', 'reference-only']);
const VALID_STATES = new Set(['ready', 'ready-empty', 'limited', 'broken', 'unverified', 'unavailable', 'policy-only']);

export async function loadFabric() {
  const raw = JSON.parse(await readFile(catalogUrl, 'utf8'));
  const connectors = [];
  const seen = new Set();

  for (const [role, ids] of Object.entries(raw.roles)) {
    if (!VALID_ROLES.has(role)) throw new Error(`invalid connector role: ${role}`);
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`duplicate connector: ${id}`);
      seen.add(id);
      const sourceId = raw.providerAliases[id] ?? id;
      const observation = raw.observations[id] ?? raw.observations[sourceId] ?? {
        state: 'policy-only',
        detail: 'Contract exists; live provider state has not been observed.'
      };
      if (!VALID_STATES.has(observation.state)) throw new Error(`invalid connector state for ${id}: ${observation.state}`);
      connectors.push({ id, role, ...observation, observedVia: sourceId });
    }
  }

  if (connectors.length !== raw.total) {
    throw new Error(`connector total mismatch: expected ${raw.total}, got ${connectors.length}`);
  }
  for (const [alias, target] of Object.entries(raw.providerAliases)) {
    if (!seen.has(alias) || !seen.has(target)) throw new Error(`invalid provider alias: ${alias} -> ${target}`);
  }

  return { ...raw, connectors };
}

export async function getConnector(id) {
  const fabric = await loadFabric();
  return fabric.connectors.find((connector) => connector.id === id) ?? null;
}
