import { createHash } from 'node:crypto';

export function digestInput(input) {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function createReceipt({ id, operation, status, reason = null, input = {}, verification = null, reconciliation = null, timestamp }) {
  return Object.freeze({
    schema: 'road-connector-receipt-v1',
    connector: id,
    operation,
    status,
    reason,
    inputSha256: digestInput(input),
    verification,
    ...(reconciliation === null ? {} : { reconciliation }),
    timestamp
  });
}

export function canonicalJson(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('receipt values must be JSON-serializable');
  return encodeCanonical(JSON.parse(encoded));
}

function encodeCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
