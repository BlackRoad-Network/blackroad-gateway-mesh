import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createEmptyState, doctorState, MessagingError } from "./core.mjs";

const DEFAULT_HOME = "/Users/alexa/workspace/.road-agents/shared/messaging";

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function resolveMessagingHome(value = process.env.ROAD_MESSAGING_HOME) {
  return resolve(value || DEFAULT_HOME);
}

export function createMessagingStore(home = resolveMessagingHome()) {
  const root = resolve(home);
  const statePath = join(root, "state.json");
  const eventPath = join(root, "events.jsonl");
  const receiptPath = join(root, "receipts.jsonl");
  const lockPath = join(root, ".lock");

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      await readFile(statePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await atomicWriteJson(statePath, createEmptyState());
    }
    return { root, statePath, eventPath, receiptPath, lockPath };
  }

  async function load() {
    await initialize();
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    const doctor = doctorState(state);
    if (!doctor.ok) {
      throw new MessagingError("STATE_INVALID", "Messaging state failed integrity validation", { errors: doctor.errors });
    }
    return state;
  }

  async function withLock(callback, options = {}) {
    await initialize();
    const timeoutMs = Number(options.timeoutMs ?? 5000);
    const pollMs = Number(options.pollMs ?? 25);
    const started = Date.now();
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - started >= timeoutMs) {
          throw new MessagingError("STATE_LOCK_TIMEOUT", `Could not acquire messaging lock within ${timeoutMs}ms`);
        }
        await sleep(pollMs);
      }
    }
    try {
      return await callback();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async function transact(mutator, options = {}) {
    return withLock(async () => {
      const before = await load();
      const beforeEventCount = before.events?.length ?? 0;
      const result = await mutator(structuredClone(before));
      if (!result?.state) throw new MessagingError("TRANSACTION_RESULT_INVALID", "Mutator must return an object containing state");
      const doctor = doctorState(result.state);
      if (!doctor.ok) {
        throw new MessagingError("STATE_INVALID", "Mutated messaging state failed integrity validation", { errors: doctor.errors });
      }
      await atomicWriteJson(statePath, result.state);
      const newEvents = (result.state.events ?? []).slice(beforeEventCount);
      for (const event of newEvents) {
        await appendDurableJsonLine(eventPath, event);
      }
      return result;
    }, options);
  }

  async function appendReceipt(receipt) {
    await initialize();
    await appendDurableJsonLine(receiptPath, receipt);
  }

  return {
    root,
    statePath,
    eventPath,
    receiptPath,
    lockPath,
    initialize,
    load,
    transact,
    appendReceipt,
  };
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  try {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is not available on every platform; atomic rename remains the primary guarantee.
  }
}

async function appendDurableJsonLine(path, value) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
