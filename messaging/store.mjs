import { mkdir, open, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createEmptyState, doctorState } from './core.mjs';

export const DEFAULT_STATE_ROOT = process.env.ROAD_MESSAGING_STATE_ROOT
  ? resolve(process.env.ROAD_MESSAGING_STATE_ROOT)
  : '/Users/alexa/workspace/.road-agents/shared/messaging';

export function paths(root = DEFAULT_STATE_ROOT) {
  const base = resolve(root);
  return {
    root: base,
    state: join(base, 'state.json'),
    events: join(base, 'events.jsonl'),
    receipts: join(base, 'receipts.jsonl'),
    lock: join(base, '.lock'),
  };
}

export async function initialize(root = DEFAULT_STATE_ROOT) {
  const p = paths(root);
  await mkdir(p.root, { recursive: true, mode: 0o700 });
  try {
    await readFile(p.state, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWriteJson(p.state, createEmptyState());
  }
  await appendFile(p.events, '', { mode: 0o600 });
  await appendFile(p.receipts, '', { mode: 0o600 });
  return p;
}

export async function loadState(root = DEFAULT_STATE_ROOT) {
  const p = await initialize(root);
  return JSON.parse(await readFile(p.state, 'utf8'));
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function acquireLock(path, { retries = 100, delayMs = 15 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === retries) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error('Unable to acquire lock');
}

export async function withStoreMutation(root, mutate) {
  const p = await initialize(root);
  const lock = await acquireLock(p.lock);
  try {
    const before = await loadState(root);
    const beforeEventCount = before.events.length;
    const result = await mutate(before);
    const next = result.state ?? result;
    const doctor = doctorState(next);
    if (!doctor.ok) throw new Error(`Refusing invalid messaging state: ${doctor.errors.join(', ')}`);
    await atomicWriteJson(p.state, next);
    for (const event of next.events.slice(beforeEventCount)) {
      await appendFile(p.events, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    const terminal = new Set(['DELIVERED','FAILED','PARTIAL','CANCELLED']);
    const previous = new Map(before.deliveries.map((delivery) => [delivery.id, delivery.state]));
    for (const delivery of next.deliveries) {
      if (terminal.has(delivery.state) && previous.get(delivery.id) !== delivery.state) {
        await appendFile(p.receipts, `${JSON.stringify({
          schema: 'road-messaging-delivery-receipt-v1',
          deliveryId: delivery.id,
          messageId: delivery.messageId,
          provider: delivery.provider,
          resourceKey: delivery.resourceKey,
          result: delivery.state,
          evidenceRefs: delivery.evidenceRefs,
          completedAt: delivery.completedAt,
          secretsPersisted: false,
        })}\n`, { mode: 0o600 });
      }
    }
    return { ...result, state: next };
  } finally {
    await lock.close();
    await rm(p.lock, { force: true });
  }
}
