import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdapterRegistry } from './adapter-sdk.mjs';
import { getConnector } from './catalog.mjs';
import { digestInput } from './receipt.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'manual-review']);

// A local filesystem queue. Only opaque context keys and input hashes are stored.
// Locks cover disk transactions, never provider calls. Expiring worker leases
// allow interrupted read-backs to resume without dispatching another write.
export class DurableReconciliationQueue {
  #directory;
  #clock;
  #graceMs;
  #retryMs;
  #timeoutMs;
  #maxAttempts;

  constructor({ directory, clock = Date.now, graceMs = 30_000, retryMs = 30_000, timeoutMs = 5_000, maxAttempts = 5 }) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    for (const value of [graceMs, retryMs, timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new RangeError('durations must be 1..86400000 ms');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new RangeError('maxAttempts must be 1..100');
    this.#directory = resolve(directory);
    this.#clock = clock;
    this.#graceMs = graceMs;
    this.#retryMs = retryMs;
    this.#timeoutMs = timeoutMs;
    this.#maxAttempts = maxAttempts;
  }

  async reserve({ id, input, contextKey }) {
    if (!UUID.test(contextKey ?? '')) throw new TypeError('contextKey must be an opaque lowercase UUID');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? '')) throw new TypeError('canonical connector id required');
    return this.#transaction(contextKey, (existing) => {
      if (existing) throw new Error('reconciliation context already reserved');
      const now = this.#now();
      return {
        schema: 'road-reconciliation-job-v1', jobId: contextKey, connector: id,
        inputSha256: digestInput(input), status: 'pending', attempts: 0,
        maxAttempts: this.#maxAttempts, retryMs: this.#retryMs,
        nextAttemptAt: now + this.#graceMs, lease: null,
        history: [{ at: now, event: 'reserved-before-dispatch' }], receipt: null
      };
    });
  }

  async settle(jobId, status) {
    if (!['unknown', 'succeeded', 'failed'].includes(status)) throw new TypeError('invalid write outcome');
    return this.#transaction(jobId, (job) => {
      if (!job) throw new Error('reconciliation job missing');
      if (TERMINAL.has(job.status)) return job;
      const now = this.#now();
      if (status === 'unknown') {
        // Preserve the reservation's initial grace deadline. The provider call
        // may still be completing and the host may not have published the
        // context/result needed for an honest read-back yet.
      } else {
        job.status = status;
        job.nextAttemptAt = null;
        job.lease = null;
      }
      job.history.push({ at: now, event: `runtime-${status}` });
      return job;
    });
  }

  async list() {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.#directory)).filter((name) => name.endsWith('.json') && UUID.test(name.slice(0, -5))).sort();
    return Promise.all(names.map((name) => this.#read(name.slice(0, -5))));
  }

  // Call explicitly from a trusted service/timer. Nothing starts on import.
  async runDue({ adapters, resolveContext, limit = 20 }) {
    if (typeof resolveContext !== 'function') throw new TypeError('resolveContext must be a function');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be 1..100');
    const registry = adapters instanceof AdapterRegistry ? adapters : new AdapterRegistry(adapters);
    const outcomes = [];
    const due = (await this.list()).filter((job) => !TERMINAL.has(job.status) && job.nextAttemptAt <= this.#now());
    due.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.jobId.localeCompare(b.jobId));
    for (const candidate of due.slice(0, limit)) {
      const token = randomUUID();
      let job;
      try {
        job = await this.#transaction(candidate.jobId, (current) => {
          const now = this.#now();
          if (!current || TERMINAL.has(current.status) || current.nextAttemptAt > now) return current;
          if (current.attempts >= current.maxAttempts) {
            current.status = 'manual-review';
            current.nextAttemptAt = null;
            current.lease = null;
            current.history.push({ at: now, event: 'attempts-exhausted' });
          } else {
            current.status = 'running';
            current.attempts += 1;
            current.lease = token;
            current.nextAttemptAt = now + this.#timeoutMs + 1_000;
            current.history.push({ at: now, event: 'read-back-started' });
          }
          return current;
        });
      } catch (error) {
        if (error.code === 'EEXIST') continue; // Another process owns this short disk transaction.
        throw error;
      }
      if (job?.lease !== token) continue;

      let event = 'read-back-unconfirmed';
      let confirmed = false;
      let permanent = false;
      let active = true;
      let timer;
      try {
        const verification = await Promise.race([
          (async () => {
            const context = await resolveContext(job.jobId);
            if (!active) throw new Error('read-back expired');
            if (!context) throw new Error('context unavailable');
            if (context.id !== job.connector || digestInput(context.input) !== job.inputSha256) {
              permanent = true;
              throw new Error('context mismatch');
            }
            const connector = await getConnector(job.connector);
            if (!active) throw new Error('read-back expired');
            const adapter = connector && registry.resolve(job.connector, connector.observedVia);
            if (typeof adapter?.verify !== 'function') throw new Error('verification unavailable');
            return adapter.verify({ connector, operation: 'write', input: context.input, result: context.result });
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read-back timeout')), this.#timeoutMs); })
        ]);
        confirmed = verification?.ok === true;
        if (confirmed) event = 'read-back-confirmed';
      } catch {
        event = permanent ? 'context-mismatch' : 'read-back-error';
      } finally {
        active = false;
        clearTimeout(timer);
      }
      const outcome = await this.#transaction(job.jobId, (current) => {
        // A late reader cannot overwrite a newer lease or a runtime completion.
        if (current.lease !== token) return current;
        const now = this.#now();
        current.lease = null;
        current.status = confirmed ? 'succeeded' : permanent || current.attempts >= current.maxAttempts ? 'manual-review' : 'pending';
        current.nextAttemptAt = current.status === 'pending' ? now + Math.min(86_400_000, current.retryMs * 2 ** (current.attempts - 1)) : null;
        current.history.push({ at: now, event });
        if (confirmed) current.receipt = {
          schema: 'road-connector-receipt-v1', connector: current.connector, operation: 'write',
          status: 'succeeded', reason: 'reconciled-by-read-back', inputSha256: current.inputSha256,
          verification: { ok: true, detail: null }, timestamp: new Date(now).toISOString()
        };
        return current;
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 172_800_000) throw new RangeError('clock must return epoch milliseconds');
    return now;
  }

  async #read(jobId) {
    try {
      const job = JSON.parse(await readFile(join(this.#directory, `${jobId}.json`), 'utf8'));
      if (job.schema !== 'road-reconciliation-job-v1' || job.jobId !== jobId ||
          !/^[a-z0-9][a-z0-9-]*$/.test(job.connector ?? '') || !/^[a-f0-9]{64}$/.test(job.inputSha256 ?? '') ||
          !['pending', 'running', ...TERMINAL].includes(job.status) ||
          !Number.isInteger(job.attempts) || job.attempts < 0 ||
          !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 100 || job.attempts > job.maxAttempts ||
          !Number.isSafeInteger(job.retryMs) || job.retryMs < 1 || job.retryMs > 86_400_000 ||
          !Array.isArray(job.history) ||
          (TERMINAL.has(job.status) ? job.nextAttemptAt !== null : !Number.isSafeInteger(job.nextAttemptAt) || job.nextAttemptAt < 0) ||
          (job.status === 'running' ? !UUID.test(job.lease ?? '') : job.lease !== null)) {
        throw new Error('invalid reconciliation job');
      }
      return job;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #transaction(jobId, update) {
    if (!UUID.test(jobId ?? '')) throw new TypeError('invalid job id');
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.#directory, `${jobId}.lock`);
    const lock = await open(lockPath, 'wx', 0o600);
    const temporary = join(this.#directory, `${jobId}.${randomUUID()}.tmp`);
    try {
      const job = update(await this.#read(jobId));
      if (!job) return null;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(job)}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, join(this.#directory, `${jobId}.json`));
      const directory = await open(this.#directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return job;
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await lock.close();
      await unlink(lockPath);
    }
  }
}
