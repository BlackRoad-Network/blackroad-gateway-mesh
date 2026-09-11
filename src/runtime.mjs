import { getConnector } from './catalog.mjs';
import { planConnectorAction } from './planner.mjs';
import { createReceipt, digestInput, snapshotJson } from './receipt.mjs';
import { AdapterRegistry } from './adapter-sdk.mjs';
import { DurableReconciliationQueue } from './reconciliation.mjs';

export class ConnectorRuntime {
  #adapters;
  #clock;
  #evidenceVerifier;
  #reconciliationQueue;

  constructor({ adapters = new Map(), clock = () => new Date().toISOString(), evidenceVerifier = null, reconciliationQueue = null } = {}) {
    if (reconciliationQueue !== null && !(reconciliationQueue instanceof DurableReconciliationQueue)) throw new TypeError('reconciliationQueue must be a DurableReconciliationQueue');
    this.#adapters = adapters instanceof AdapterRegistry ? adapters : new AdapterRegistry(adapters);
    this.#clock = clock;
    this.#evidenceVerifier = evidenceVerifier;
    this.#reconciliationQueue = reconciliationQueue;
  }

  async probe(id) {
    const connector = await getConnector(id);
    if (!connector) return { id, reachable: false, state: 'unknown', reason: 'unknown-connector' };

    const adapter = this.#adapters.resolve(id, connector.observedVia);
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

  async execute({ id, operation, input: requestedInput = {}, evidence = {}, principal = null, sessionId = null, dryRun = true, contextKey = null }) {
    // Capture provider input before the first await so caller mutation cannot
    // change the operation after its digest has been authorized.
    const input = snapshotJson(requestedInput);
    const timestamp = this.#clock();
    const context = { id, operation, inputSha256: digestInput(input), principal, sessionId };
    let plan = await planConnectorAction(id, operation, evidence, { verifier: this.#evidenceVerifier, context });
    if (!plan.allowed) return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: plan.reason, input, timestamp }) };
    if (dryRun) return { plan, receipt: createReceipt({ id, operation, status: 'planned', reason: 'dry-run', input, timestamp }) };

    const connector = await getConnector(id);
    const adapter = this.#adapters.resolve(id, connector.observedVia);
    if (!adapter?.execute) {
      return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: 'adapter-not-registered', input, timestamp }) };
    }
    if (!adapter.operations.includes(operation)) {
      return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: 'adapter-operation-not-supported', input, timestamp }) };
    }
    if (operation === 'write' && typeof adapter.verify !== 'function') {
      return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: 'verification-not-implemented', input, timestamp }) };
    }

    if (operation === 'write') {
      plan = await planConnectorAction(id, operation, evidence, { verifier: this.#evidenceVerifier, context, consume: true });
      if (!plan.allowed) return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: plan.reason, input, timestamp }) };
    }

    let jobId;
    if (operation === 'write' && this.#reconciliationQueue) {
      try {
        ({ jobId } = await this.#reconciliationQueue.reserve({ id, input, contextKey }));
      } catch {
        return { plan, receipt: createReceipt({ id, operation, status: 'blocked', reason: 'reconciliation-reservation-failed', input, timestamp }) };
      }
    }

    let result;
    let phase = 'execute';
    try {
      result = await adapter.execute({ connector, operation, input });
      if (operation === 'write') {
        phase = 'verify';
        const verification = await adapter.verify({ connector, operation, input, result });
        const succeeded = verification?.ok === true;
        const receipt = createReceipt({
          id, operation, status: succeeded ? 'succeeded' : 'failed',
          ...(succeeded ? {} : { reason: 'read-after-write-verification-failed' }),
          input, verification: publicVerification(verification), timestamp
        });
        phase = 'persist';
        if (jobId) await this.#reconciliationQueue.settle(jobId, receipt.status, receipt);
        return { plan, result, receipt };
      }
      return { plan, result, receipt: createReceipt({ id, operation, status: 'succeeded', input, timestamp }) };
    } catch (error) {
      if (operation === 'write') {
        // A thrown call does not prove that the provider rolled back the write.
        // Keep any acknowledged result available for a later read-back. Consumed
        // approval stays consumed; only the orchestrator may reconcile the state.
        if (jobId) {
          // The pre-dispatch record remains recoverable if this update fails.
          try { await this.#reconciliationQueue.settle(jobId, 'unknown'); } catch { /* Retain the durable intent. */ }
        }
        return { plan, result, receipt: createReceipt({
          id, operation, status: 'unknown',
          reason: phase === 'persist' ? 'reconciliation-persistence-error' : phase === 'verify' ? 'read-after-write-verification-error' : 'write-outcome-unknown',
          input, verification: { detail: safeError(error) },
          reconciliation: { required: true, automaticRetry: false, ...(jobId ? { jobId } : {}) }, timestamp
        }) };
      }
      return { plan, receipt: createReceipt({ id, operation, status: 'failed', reason: 'adapter-execution-failed', input, verification: { detail: safeError(error) }, timestamp }) };
    }
  }
}

function publicVerification(verification) {
  if (!verification) return null;
  return { ok: verification.ok === true, detail: publicDetail(verification.detail) };
}

function publicDetail(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240);
}

function safeError(error) {
  return error instanceof Error ? error.name : 'Error';
}
