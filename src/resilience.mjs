export class TimeoutError extends Error {
  constructor(message = 'connector invocation timed out') {
    super(message);
    this.name = 'TimeoutError';
    this.transient = true;
  }
}

export class CircuitOpenError extends Error {
  constructor(key) {
    super(`connector circuit is open: ${key}`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  #states = new Map();
  #failureThreshold;
  #cooldownMs;
  #clock;

  constructor({ failureThreshold = 3, cooldownMs = 30_000, clock = Date.now } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError('failureThreshold must be a positive integer');
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new RangeError('cooldownMs must be non-negative');
    this.#failureThreshold = failureThreshold;
    this.#cooldownMs = cooldownMs;
    this.#clock = clock;
  }

  allow(key) {
    const state = this.#states.get(key);
    if (!state || state.failures < this.#failureThreshold) return true;
    if (this.#clock() - state.openedAt < this.#cooldownMs) return false;
    this.#states.set(key, { failures: this.#failureThreshold - 1, openedAt: null });
    return true;
  }

  success(key) {
    this.#states.delete(key);
  }

  failure(key) {
    const current = this.#states.get(key) ?? { failures: 0, openedAt: null };
    const failures = current.failures + 1;
    this.#states.set(key, { failures, openedAt: failures >= this.#failureThreshold ? this.#clock() : current.openedAt });
  }

  state(key) {
    const current = this.#states.get(key);
    if (!current) return 'closed';
    return current.failures >= this.#failureThreshold ? 'open' : 'closed';
  }
}

export async function invokeWithResilience({ key, operation, invoke, attempts = 3, timeoutMs = 5_000, breaker = new CircuitBreaker(), delay = async () => {} }) {
  if (!['read', 'write'].includes(operation)) throw new TypeError('operation must be read or write');
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  const maximum = operation === 'write' ? 1 : attempts;
  if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError('attempts must be a positive integer');
  if (!breaker.allow(key)) throw new CircuitOpenError(key);

  let lastError;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    try {
      const result = await withTimeout(invoke(), timeoutMs);
      breaker.success(key);
      return result;
    } catch (error) {
      lastError = error;
      breaker.failure(key);
      if (attempt === maximum || error?.transient !== true || !breaker.allow(key)) break;
      await delay({ attempt, error });
    }
  }
  throw lastError;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('timeoutMs must be positive'));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError()), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
