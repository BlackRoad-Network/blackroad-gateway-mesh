import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MessagingError } from './framework.mjs';
import { enqueueHandoffPlans } from './outbox.mjs';
import { createEmptyMessagingPipelineState, processInboundEvent } from './pipeline.mjs';

const SECRET_TEXT_PATTERNS = [
  /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
];

export function resolveMessagingStateRoot(input = {}) {
  if (input.stateRoot) return resolve(String(input.stateRoot));
  if (input.env?.ROAD_MESSAGING_STATE_ROOT) return resolve(String(input.env.ROAD_MESSAGING_STATE_ROOT));
  const workspace = input.env?.ROAD_WORKSPACE_ROOT || '/Users/alexa/workspace';
  return resolve(workspace, '.road-agents', 'shared', 'messaging');
}

export function storePaths(stateRoot) {
  const root = resolve(String(stateRoot));
  return {
    root,
    state: join(root, 'state.json'),
    lock: join(root, '.state.lock'),
    lockOwner: join(root, '.state.lock', 'owner.json'),
    receipts: join(root, 'receipts.jsonl'),
  };
}

function assertSafeSerializedState(text) {
  for (const pattern of SECRET_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      throw new MessagingError('SECRET_MATERIAL_REJECTED', 'Messaging state serialization appears to contain credential material');
    }
  }
}

export async function initializeMessagingStore(stateRoot) {
  const paths = storePaths(stateRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  try {
    await stat(paths.state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writePipelineState(paths.root, createEmptyMessagingPipelineState());
  }
  return paths;
}

export async function readPipelineState(stateRoot) {
  const paths = storePaths(stateRoot);
  try {
    const parsed = JSON.parse(await readFile(paths.state, 'utf8'));
    if (parsed.schema !== 'road-messaging-pipeline-state-v1') {
      throw new MessagingError('STATE_SCHEMA_INVALID', `Unexpected messaging state schema ${parsed.schema || '<missing>'}`);
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return createEmptyMessagingPipelineState();
    if (error instanceof SyntaxError) throw new MessagingError('STATE_JSON_INVALID', `Messaging state JSON is invalid: ${error.message}`);
    throw error;
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePipelineState(stateRoot, state) {
  const paths = storePaths(stateRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(state, null, 2)}\n`;
  assertSafeSerializedState(text);
  const temporary = join(paths.root, `.state.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, paths.state);
  await chmod(paths.state, 0o600);
  await fsyncDirectory(paths.root);
  return paths.state;
}

async function readLockOwner(paths) {
  try {
    return JSON.parse(await readFile(paths.lockOwner, 'utf8'));
  } catch {
    return null;
  }
}

export async function acquireMessagingLock(stateRoot, options = {}) {
  const paths = storePaths(stateRoot);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const timeoutMs = Math.max(50, Number(options.timeoutMs || 5000));
  const staleMs = Math.max(1000, Number(options.staleMs || 30000));
  const retryMs = Math.max(5, Number(options.retryMs || 25));
  const owner = {
    id: randomUUID(),
    pid: process.pid,
    agentId: options.agentId || null,
    sessionRef: options.sessionRef || null,
    acquiredAt: new Date().toISOString(),
  };

  while (true) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      await writeFile(paths.lockOwner, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
      return {
        owner,
        async release() {
          const current = await readLockOwner(paths);
          if (current?.id !== owner.id) {
            throw new MessagingError('LOCK_OWNER_MISMATCH', 'Messaging state lock is no longer owned by this transaction');
          }
          await rm(paths.lock, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await readLockOwner(paths);
      const age = current?.acquiredAt ? Date.now() - new Date(current.acquiredAt).getTime() : 0;
      if (current && Number.isFinite(age) && age > staleMs) {
        await rm(paths.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new MessagingError('STATE_LOCK_TIMEOUT', 'Timed out waiting for messaging state lock', {
          currentOwner: current ? {
            pid: current.pid,
            agentId: current.agentId,
            sessionRef: current.sessionRef,
            acquiredAt: current.acquiredAt,
          } : null,
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryMs));
    }
  }
}

export async function withMessagingTransaction(stateRoot, transform, options = {}) {
  const lock = await acquireMessagingLock(stateRoot, options);
  try {
    const current = await readPipelineState(stateRoot);
    const result = await transform(current);
    if (!result || !result.state) throw new MessagingError('TRANSACTION_STATE_REQUIRED', 'Messaging transaction must return a state');
    await writePipelineState(stateRoot, result.state);
    return result;
  } finally {
    await lock.release();
  }
}

export async function ingestInboundTransaction(stateRoot, event, options = {}) {
  return withMessagingTransaction(stateRoot, async (current) => {
    const processed = processInboundEvent(current, event, options);
    if (processed.handoffPlans.length === 0) return processed;
    const enqueued = enqueueHandoffPlans(processed.state, processed.handoffPlans, options);
    return {
      ...processed,
      state: enqueued.state,
      outboxCreated: enqueued.created,
      outboxReplayed: enqueued.replayed,
    };
  }, options);
}

export async function appendReferenceReceipt(stateRoot, receipt) {
  const paths = storePaths(stateRoot);
  await mkdir(dirname(paths.receipts), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(receipt)}\n`;
  assertSafeSerializedState(text);
  const handle = await open(paths.receipts, 'a', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(paths.receipts, 0o600);
  return paths.receipts;
}
