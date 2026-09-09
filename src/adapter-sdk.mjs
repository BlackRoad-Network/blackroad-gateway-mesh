const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]*$/;
const OPERATIONS = new Set(['read', 'write']);

export function defineAdapter({ id, operations = ['read'], probe, execute, verify }) {
  if (!CONNECTOR_ID.test(id ?? '')) throw new TypeError('adapter id must be a canonical connector id');
  if (!Array.isArray(operations) || operations.length === 0) throw new TypeError(`${id}: operations must be a non-empty array`);
  if (new Set(operations).size !== operations.length || operations.some((operation) => !OPERATIONS.has(operation))) {
    throw new TypeError(`${id}: operations must contain unique read/write values`);
  }
  if (probe !== undefined && typeof probe !== 'function') throw new TypeError(`${id}: probe must be a function`);
  if (typeof execute !== 'function') throw new TypeError(`${id}: execute must be a function`);
  if (operations.includes('write') && typeof verify !== 'function') {
    throw new TypeError(`${id}: write adapters must implement read-after-write verification`);
  }
  if (verify !== undefined && typeof verify !== 'function') throw new TypeError(`${id}: verify must be a function`);

  return Object.freeze({ id, operations: Object.freeze([...operations]), probe, execute, verify });
}

export class AdapterRegistry {
  #adapters = new Map();

  constructor(adapters = []) {
    const entries = adapters instanceof Map
      ? adapters.entries()
      : Array.isArray(adapters)
        ? adapters.map((adapter) => [adapter.id, adapter])
        : Object.entries(adapters);
    for (const [id, adapter] of entries) this.register(id, adapter);
  }

  register(id, adapter) {
    if (!CONNECTOR_ID.test(id ?? '')) throw new TypeError('registry key must be a canonical connector id');
    if (!adapter || typeof adapter !== 'object') throw new TypeError(`${id}: adapter must be an object`);
    if (this.#adapters.has(id)) throw new Error(`adapter already registered: ${id}`);
    const validated = defineAdapter({
      id,
      operations: adapter.operations ?? ['read'],
      probe: adapter.probe,
      execute: adapter.execute,
      verify: adapter.verify
    });
    this.#adapters.set(id, validated);
    return this;
  }

  resolve(id, providerAlias = id) {
    return this.#adapters.get(id) ?? this.#adapters.get(providerAlias) ?? null;
  }

  list() {
    return [...this.#adapters.keys()].sort();
  }

  get size() {
    return this.#adapters.size;
  }
}

export function inspectAdapter(adapter, connector) {
  const errors = [];
  const warnings = [];
  const operations = Array.isArray(adapter?.operations) ? adapter.operations : ['read'];

  if (!adapter || typeof adapter !== 'object') errors.push('adapter-not-object');
  if (typeof adapter?.execute !== 'function') errors.push('execute-missing');
  if (operations.some((operation) => !connector.capabilities.operations.includes(operation))) errors.push('operation-exceeds-contract');
  if (operations.includes('write') && typeof adapter?.verify !== 'function') errors.push('write-verification-missing');
  if (typeof adapter?.probe !== 'function') warnings.push('probe-missing');

  return Object.freeze({ valid: errors.length === 0, connector: connector.id, operations: [...operations], errors, warnings });
}
