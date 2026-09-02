import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath, { timeoutMs = 2_000, staleMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`journal_lock_timeout:${lockPath}`), { code: "JOURNAL_LOCK_TIMEOUT" });
      }
      await sleep(20);
    }
  }
}

export async function readJournal(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw Object.assign(new Error(`invalid_journal_line:${path}:${index + 1}`), {
          code: "INVALID_JOURNAL",
          cause: error
        });
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendJournal(path, record, options = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${path}.lock`, options);
  try {
    const current = await readJournal(path);
    const previousHash = current.at(-1)?.eventHash ?? null;
    const envelope = {
      eventId: record.eventId ?? `event_${randomUUID()}`,
      recordedAt: record.recordedAt ?? new Date().toISOString(),
      previousHash,
      ...record,
      eventHash: null
    };
    envelope.eventHash = sha256({ ...envelope, eventHash: null });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(envelope)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return envelope;
  } finally {
    await release();
  }
}

export function verifyJournal(records) {
  const errors = [];
  let previousHash = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.previousHash !== previousHash) errors.push({ index, code: "PREVIOUS_HASH_MISMATCH" });
    const expected = sha256({ ...record, eventHash: null });
    if (record.eventHash !== expected) errors.push({ index, code: "EVENT_HASH_MISMATCH" });
    previousHash = record.eventHash;
  }
  return { ok: errors.length === 0, count: records.length, headHash: previousHash, errors };
}

export function journalPath(stateRoot, name) {
  return join(stateRoot, `${name}.jsonl`);
}

export const journalInternals = { stableStringify, sha256, acquireLock };
