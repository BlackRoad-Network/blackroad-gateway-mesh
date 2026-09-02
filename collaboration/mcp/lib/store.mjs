import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  constructor({ statePath, eventsPath, lockTimeoutMs = 10_000, staleLockMs = 30_000 } = {}) {
    if (!statePath) throw new Error("statePath-required");
    this.statePath = statePath;
    this.eventsPath = eventsPath ?? join(dirname(statePath), "mcp-events.jsonl");
    this.lockPath = `${statePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  async init() {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      await stat(this.statePath);
    } catch {
      await this.#atomicWrite(emptyState());
    }
  }

  async read() {
    await this.init();
    const raw = await readFile(this.statePath, "utf8");
    const state = JSON.parse(raw);
    return { ...emptyState(), ...state };
  }

  async transact({ actor, type, data = {} }, mutator) {
    assertNoSecrets(data);
    const release = await this.#acquire();
    try {
      const state = await this.read();
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
      await writeFile(this.eventsPath, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
      return { result, state, event };
    } finally {
      await release();
    }
  }

  async #atomicWrite(state) {
    const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.statePath);
  }

  async #acquire() {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        return async () => {
          await handle.close().catch(() => {});
          await rm(this.lockPath, { force: true });
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > this.staleLockMs) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {}
        await sleep(20);
      }
    }
    throw new Error("collaboration-state-contention");
  }
}
