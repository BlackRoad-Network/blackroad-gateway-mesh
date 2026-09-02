import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createEmptyState, CollaborationError } from './core.mjs';

const STATE_FILE = 'state.json';
const EVENTS_FILE = 'events.jsonl';
const RECEIPTS_FILE = 'receipts.jsonl';
const LOCK_DIR = '.lock';

function ensureFile(path) {
  if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
}

export function ensureHome(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const statePath = join(home, STATE_FILE);
  if (!existsSync(statePath)) atomicWriteJson(statePath, createEmptyState());
  ensureFile(join(home, EVENTS_FILE));
  ensureFile(join(home, RECEIPTS_FILE));
  return statePath;
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function loadState(home) {
  const path = ensureHome(home);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CollaborationError('STATE_READ_FAILED', `Could not read ${path}: ${error.message}`);
  }
}

export function saveState(home, state) {
  atomicWriteJson(join(home, STATE_FILE), state);
}

function appendJsonLines(path, values) {
  for (const value of values) appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function acquireLock(home) {
  ensureHome(home);
  const lockPath = join(home, LOCK_DIR);
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    throw new CollaborationError('LOCK_BUSY', `Collaboration state is locked${ageMs > 60000 ? ' and may be stale' : ''}`, {
      lockPath,
      ageMs,
    });
  }
  writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), command: process.argv })}\n`, { mode: 0o600 });
  return () => rmSync(lockPath, { recursive: true, force: true });
}

export function mutateState(home, mutation) {
  const release = acquireLock(home);
  try {
    const before = loadState(home);
    const eventCount = before.events?.length ?? 0;
    const receiptCount = before.receipts?.length ?? 0;
    const result = mutation(before);
    const state = result.state ?? result;
    saveState(home, state);
    appendJsonLines(join(home, EVENTS_FILE), (state.events ?? []).slice(eventCount));
    appendJsonLines(join(home, RECEIPTS_FILE), (state.receipts ?? []).slice(receiptCount));
    return result;
  } finally {
    release();
  }
}

export function readRecentJsonLines(home, file, limit = 20) {
  ensureHome(home);
  const path = join(home, file);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return lines.slice(Math.max(0, lines.length - limit)).map((line) => JSON.parse(line));
}

export const stateFiles = Object.freeze({
  state: STATE_FILE,
  events: EVENTS_FILE,
  receipts: RECEIPTS_FILE,
});
