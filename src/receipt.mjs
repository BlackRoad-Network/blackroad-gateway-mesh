import { createHash } from 'node:crypto';

export function digestInput(input) {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export function createReceipt({ id, operation, status, reason = null, input = {}, verification = null, timestamp }) {
  return Object.freeze({
    schema: 'road-connector-receipt-v1',
    connector: id,
    operation,
    status,
    reason,
    inputSha256: digestInput(input),
    verification,
    timestamp
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
