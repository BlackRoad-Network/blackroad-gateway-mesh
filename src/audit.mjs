import { loadFabric } from './catalog.mjs';

const HEALTHY = new Set(['ready', 'ready-empty', 'limited']);

export async function auditConnectors({ runtime, ids, concurrency = 4, clock = () => new Date().toISOString() }) {
  if (!runtime || typeof runtime.probe !== 'function') throw new TypeError('runtime with probe(id) is required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new RangeError('concurrency must be an integer from 1 to 16');

  const fabric = await loadFabric();
  const selected = ids ?? fabric.connectors.map(({ id }) => id);
  const known = new Set(fabric.connectors.map(({ id }) => id));
  const unknown = selected.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown connectors: ${unknown.join(', ')}`);

  const results = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      results[index] = await runtime.probe(selected[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));

  const states = results.reduce((counts, result) => {
    counts[result.state] = (counts[result.state] ?? 0) + 1;
    return counts;
  }, {});
  return Object.freeze({
    schema: 'road-connector-health-v1',
    checkedAt: clock(),
    total: results.length,
    healthy: results.filter((result) => HEALTHY.has(result.state)).length,
    states,
    results: Object.freeze(results)
  });
}

export function diffHealthSnapshots(before, after) {
  const previous = new Map(before.results.map((result) => [result.id, result]));
  const transitions = after.results.flatMap((current) => {
    const prior = previous.get(current.id);
    if (!prior || prior.state === current.state && prior.reachable === current.reachable) return [];
    const wasHealthy = HEALTHY.has(prior.state);
    const isHealthy = HEALTHY.has(current.state);
    return [{
      id: current.id,
      from: prior.state,
      to: current.state,
      change: !wasHealthy && isHealthy ? 'recovered' : wasHealthy && !isHealthy ? 'degraded' : 'changed'
    }];
  });
  return Object.freeze({
    schema: 'road-connector-health-diff-v1',
    before: before.checkedAt,
    after: after.checkedAt,
    changed: transitions.length,
    recovered: transitions.filter(({ change }) => change === 'recovered').length,
    degraded: transitions.filter(({ change }) => change === 'degraded').length,
    transitions: Object.freeze(transitions)
  });
}
