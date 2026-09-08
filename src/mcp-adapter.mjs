import { defineAdapter } from './adapter-sdk.mjs';
import { CircuitBreaker, invokeWithResilience } from './resilience.mjs';

export function createMcpAdapter({ id, operations = ['read'], invoke, actions, resilience = {} }) {
  if (typeof invoke !== 'function') throw new TypeError(`${id}: MCP invoke function required`);
  if (!actions || typeof actions !== 'object') throw new TypeError(`${id}: MCP action map required`);
  for (const operation of operations) {
    if (!actions[operation]?.tool) throw new TypeError(`${id}: ${operation} action tool required`);
  }
  if (operations.includes('write') && !actions.verify?.tool) throw new TypeError(`${id}: verify action tool required for writes`);

  const breaker = resilience.breaker ?? new CircuitBreaker(resilience);
  const call = (action, operation, context) => invokeWithResilience({
    key: `${id}:${action.tool}`,
    operation,
    invoke: () => invoke(action.tool, action.buildArguments ? action.buildArguments(context) : context.input ?? {}),
    attempts: resilience.attempts,
    timeoutMs: resilience.timeoutMs,
    breaker,
    delay: resilience.delay
  });

  return defineAdapter({
    id,
    operations,
    probe: actions.probe ? async (context) => normalizeProbe(await call(actions.probe, 'read', context)) : undefined,
    execute: async (context) => call(actions[context.operation], context.operation, context),
    verify: actions.verify ? async (context) => normalizeVerification(await call(actions.verify, 'read', context)) : undefined
  });
}

function normalizeProbe(value) {
  return {
    ok: value?.ok === true,
    state: typeof value?.state === 'string' ? value.state : undefined,
    detail: publicDetail(value?.detail)
  };
}

function normalizeVerification(value) {
  return { ok: value?.ok === true, detail: publicDetail(value?.detail) };
}

function publicDetail(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').slice(0, 240) : null;
}
