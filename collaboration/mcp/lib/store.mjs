import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

const SECRET_KEY = /(^|_)(authorization|cookie|password|passwd|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret)(_|$)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+/=-]{12,}|\bsk-(?:proj-)?[a-z0-9_-]{12,}|\bgh[pousr]_[a-z0-9]{20,}|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----)/i;

export function assertNoSecrets(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const referenceField = /(ref|reference)$/i.test(key);
      if (SECRET_KEY.test(key) && !referenceField && entry != null) {
        throw new Error(`secret-field-rejected:${path}.${key}`);
      }
      assertNoSecrets(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`secret-value-rejected:${path}`);
  }
}

function emptyState() {
  return {
    schema: "road-collaboration-mcp-state-v1",
    generation: 0,
    eventHead: null,
    sessions: {},
    workflows: {},
    workItems: {},
    delegations: {},
    notifications: {},
    resources: {},
    events: []
  };
}

export class JsonStateStore {
  constructor({ statePath, eventsPath, lockTimeoutMs = 10_000 } = {}) {
    if (!statePath) throw new Error("statePath-required");
    this.statePath = statePath;
    this.eventsPath = eventsPath ?? join(dirname(statePath), "mcp-events.jsonl");
    this.lockPath = `${statePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    if ([resolve(this.statePath), resolve(this.lockPath)].includes(resolve(this.eventsPath))) {
      throw new Error("event-log-path-conflict");
    }
  }

  async init() {
    const release = await this.#acquire();
    try {
      const state = await this.read();
      await this.#syncEvents(state);
      await this.#atomicWrite(state);
    } finally {
      await release();
    }
  }

  async read() {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8"));
      return { ...emptyState(), ...state };
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async reconcileEvents() {
    const release = await this.#acquire();
    try {
      const state = await this.read();
      await this.#syncEvents(state);
      return { generation: state.generation, eventHead: state.eventHead, eventLogPending: false };
    } finally {
      await release();
    }
  }

  async transact({ actor, type, data = {} }, mutator) {
    assertNoSecrets(data);
    const release = await this.#acquire();
    try {
      const state = await this.read();
      // Recover the previous commit before another event can evict it from state.
      await this.#syncEvents(state);
      const result = await mutator(state);
      assertNoSecrets(state);
      state.generation = Number(state.generation ?? 0) + 1;
      const at = new Date().toISOString();
      const event = {
        id: `evt_${randomUUID()}`,
        sequence: state.generation,
        at,
        actor,
        type,
        data,
        previousHash: state.eventHead
      };
      event.hash = sha256(event);
      state.eventHead = event.hash;
      state.events = [...(state.events ?? []), event].slice(-500);
      await this.#atomicWrite(state);
      // The state rename is the commit point. A projection failure cannot undo it.
      let eventLogPending = false;
      try { await this.#syncEvents(state); } catch { eventLogPending = true; }
      return { result, state, event, committed: true, eventLogPending };
    } finally {
      await release();
    }
  }

  async #syncEvents(state) {
    let raw = "";
    let missing = false;
    try { raw = await readFile(this.eventsPath, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing = true;
    }
    if (raw && !raw.endsWith("\n")) throw new Error("event-log-incomplete");
    const events = raw ? raw.slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
    const originalLength = events.length;
    if (!Number.isSafeInteger(state.generation) || state.generation < 0 || events.length > state.generation) {
      throw new Error("event-log-generation-conflict");
    }
    // Retained events bridge only a missing tail, never a conflicting history.
    const retained = new Map(state.events.map((event) => [event.sequence, event]));
    for (let sequence = events.length + 1; sequence <= state.generation; sequence++) {
      if (!retained.has(sequence)) throw new Error("event-log-recovery-gap");
      events.push(retained.get(sequence));
    }
    let previousHash = null;
    for (const [index, event] of events.entries()) {
      const { hash, ...body } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || sha256(body) !== hash) {
        throw new Error("event-log-chain-conflict");
      }
      const saved = retained.get(event.sequence);
      if (saved && canonicalJson(saved) !== canonicalJson(event)) throw new Error("event-log-state-conflict");
      previousHash = hash;
    }
    if (previousHash !== state.eventHead) throw new Error("event-log-head-conflict");
    if (missing || originalLength !== events.length) {
      await this.#replace(this.eventsPath, events.map((event) => JSON.stringify(event) + "\n").join(""));
    }
  }

  async #atomicWrite(state) {
    await this.#replace(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #replace(path, content) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, path);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  async #acquire() {
    await mkdir(dirname(this.statePath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        } catch (error) {
          await handle.close().catch(() => {});
          await rm(this.lockPath, { force: true }).catch(() => {});
          throw error;
        }
        return async () => {
          await handle.close().catch(() => {});
          await rm(this.lockPath, { force: true }).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        // Age does not establish that a lock owner has stopped. Never steal it.
        await sleep(20);
      }
    }
    throw new Error("collaboration-state-contention");
  }
}
