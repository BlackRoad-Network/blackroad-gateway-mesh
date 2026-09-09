const DEFAULT_MAX_LIFETIME_MS = 5 * 60 * 1000;

export class EvidenceVerifier {
  #clock;
  #maxLifetimeMs;
  #verifyProof;
  #usedNonces = new Set();
  #reservedNonces = new Set();

  constructor({ verifyProof, clock = () => new Date().toISOString(), maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS } = {}) {
    if (typeof verifyProof !== 'function') throw new TypeError('evidence proof verifier required');
    if (typeof clock !== 'function') throw new TypeError('evidence clock must be a function');
    if (!Number.isInteger(maxLifetimeMs) || maxLifetimeMs < 1) throw new TypeError('max evidence lifetime must be a positive integer');
    this.#verifyProof = verifyProof;
    this.#clock = clock;
    this.#maxLifetimeMs = maxLifetimeMs;
  }

  async verify(requirements, evidence, context, { consume = false } = {}) {
    const errors = [];
    const accepted = [];
    const reserved = [];
    const nowMs = Date.parse(this.#clock());
    if (!Number.isFinite(nowMs)) throw new TypeError('evidence clock must return an ISO timestamp');

    for (const requirement of requirements) {
      const record = evidence?.[requirement];
      const error = validateRecord(requirement, record, context, nowMs, this.#maxLifetimeMs, this.#usedNonces, this.#reservedNonces, accepted);
      if (error) {
        errors.push(`${requirement}:${error}`);
        continue;
      }
      accepted.push(record);
    }

    if (errors.length === 0 && consume) {
      for (const record of accepted) {
        this.#reservedNonces.add(record.nonce);
        reserved.push(record.nonce);
      }
    }

    if (errors.length === 0) for (const record of accepted) {
      let proofValid = false;
      try {
        proofValid = await this.#verifyProof(record, { ...context, requirement: record.requirement });
      } catch {}
      if (proofValid !== true) {
        errors.push(`${record.requirement}:proof-invalid`);
      }
    }

    if (consume) {
      for (const nonce of reserved) this.#reservedNonces.delete(nonce);
      if (errors.length === 0) for (const record of accepted) this.#usedNonces.add(record.nonce);
    }
    return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), consumed: consume && errors.length === 0 });
  }
}

function validateRecord(requirement, record, context, nowMs, maxLifetimeMs, usedNonces, reservedNonces, accepted) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record-required';
  if (record.requirement !== requirement) return 'requirement-mismatch';
  if (!nonEmpty(record.principal) || record.principal !== context.principal) return 'principal-mismatch';
  if (!nonEmpty(record.sessionId) || record.sessionId !== context.sessionId) return 'session-mismatch';
  if (record.targetId !== context.id) return 'target-mismatch';
  if (record.operation !== context.operation) return 'operation-mismatch';
  if (record.inputSha256 !== context.inputSha256) return 'input-mismatch';
  if (!nonEmpty(record.issuer)) return 'issuer-required';
  if (!nonEmpty(record.nonce)) return 'nonce-required';
  if (!nonEmpty(record.proof)) return 'proof-required';
  if (usedNonces.has(record.nonce) || reservedNonces.has(record.nonce) || accepted.some(({ nonce }) => nonce === record.nonce)) return 'replayed';

  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return 'time-invalid';
  if (issuedAt > nowMs || expiresAt <= nowMs) return 'expired-or-not-yet-valid';
  if (expiresAt - issuedAt > maxLifetimeMs) return 'lifetime-too-long';
  return null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}
