import { getConnector } from './catalog.mjs';

const EXECUTABLE_STATES = new Set(['ready', 'ready-empty', 'limited']);

export async function planConnectorAction(id, operation, evidence = {}) {
  const connector = await getConnector(id);
  if (!connector) return blocked(id, operation, 'unknown-connector');
  if (!['read', 'write'].includes(operation)) return blocked(id, operation, 'unknown-operation');
  if (connector.role === 'reference-only') return blocked(id, operation, 'reference-only');
  if (!EXECUTABLE_STATES.has(connector.state)) return blocked(id, operation, `connector-${connector.state}`);

  if (operation === 'read') {
    return { allowed: true, id, operation, role: connector.role, state: connector.state, requirements: [] };
  }

  if (connector.role === 'event') return blocked(id, operation, 'event-connectors-are-read-only');

  const requirements = ['exact-live-session', 'target-ownership', 'exclusive-claim', 'semantic-idempotency', 'provider-authentication', 'read-after-write-verification'];
  if (connector.role === 'discussion' || connector.role === 'delivery') requirements.push('explicit-user-approval');
  if (connector.role === 'control' || connector.role === 'decision') requirements.push('explicit-user-approval', 'governance-evidence');

  const missing = requirements.filter((requirement) => evidence[requirement] !== true);
  return {
    allowed: missing.length === 0,
    id,
    operation,
    role: connector.role,
    state: connector.state,
    requirements,
    missing,
    reason: missing.length ? 'missing-required-evidence' : null
  };
}

function blocked(id, operation, reason) {
  return { allowed: false, id, operation, reason, requirements: [], missing: [] };
}
