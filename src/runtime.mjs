import { getConnector } from './catalog.mjs';
import { planConnectorAction } from './planner.mjs';
import { createReceipt } from './receipt.mjs';

export class ConnectorRuntime {
  #adapters;
  #clock;

  constructor({ adapters = new Map(), clock = () => new Date().toISOString() } = {}) {
    this.#adapters = adapters instanceof Map ? new Map(adapters) : new Map(Object.entries(adapters));
    this.#clock = clock;
  }

  async probe(id) {
    const connector = await getConnector(id);
    if (!connector) return { id, reachable: false, state: 'unknown', reason: 'unknown-connector' };

    const adapter = this.#adapters.get(id) ?? this.#adapters.get(connector.observedVia);
    if (!adapter?.probe) {
      return {
        id,
        reachable: ['ready', 'ready-empty', 'limited'].includes(connector.state),
        state: connector.state,
        source: 'catalog',
        detail: connector.detail
      };
    }

    try {
      const result = await adapter.probe({ connector });
      return { id, reachable: result?.ok === true, state: result?.state ?? connector.state, source: 'adapter', detail: result?.detail ?? null };
    } catch (error) {
      return { id, reachable: false, state: 'broken', source: 'adapter', reason: 'probe-failed', detail: safeError(error) };
    }
  }

  async execute({ id, operation, input = {}, evidence = {}, dryRun = true }) {
    const timestamp = this.#clock();
    const plan = await planConnectorAction(id, operation, evidence);
    if (!plan.allowed) return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: plan.reason, input, timestamp }) };
    if (dryRun) return { plan, receipt: createReceipt({ id, operation, status: 'planned', reason: 'dry-run', input, timestamp }) };

    const connector = await getConnector(id);
    const adapter = this.#adapters.get(id) ?? this.#adapters.get(connector.observedVia);
    if (!adapter?.execute) {
      return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: 'adapter-not-registered', input, timestamp }) };
    }

    try {
      const result = await adapter.execute({ connector, operation, input });
      if (operation === 'write') {
        if (!adapter.verify) {
          return { plan, result, receipt: createReceipt({ id, operation, status: 'failed', reason: 'verification-not-implemented', input, timestamp }) };
        }
        const verification = await adapter.verify({ connector, operation, input, result });
        if (verification?.ok !== true) {
          return { plan, result, receipt: createReceipt({ id, operation, status: 'failed', reason: 'read-after-write-verification-failed', input, verification: publicVerification(verification), timestamp }) };
        }
        return { plan, result, receipt: createReceipt({ id, operation, status: 'succeeded', input, verification: publicVerification(verification), timestamp }) };
      }
      return { plan, result, receipt: createReceipt({ id, operation, status: 'succeeded', input, timestamp }) };
    } catch (error) {
      return { plan, receipt: createReceipt({ id, operation, status: 'failed', reason: 'adapter-execution-failed', input, verification: { detail: safeError(error) }, timestamp }) };
    }
  }
}

function publicVerification(verification) {
  if (!verification) return null;
  return { ok: verification.ok === true, detail: typeof verification.detail === 'string' ? verification.detail : null };
}

function safeError(error) {
  return error instanceof Error ? error.name : 'Error';
}
