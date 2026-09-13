import { constants } from "node:fs";
import { open, link, unlink, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SlackReferenceInbox, restoreSlackInboxEvent } from "./slack-reference-inbox.mjs";
import { planSlackCommandIntake } from "./slack-control-plane.mjs";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const keyFor = (record) => {
  if (typeof record?.canonicalEventId !== "string" || !/^road:\/\/event\/[a-f0-9]{64}$/.test(record.canonicalEventId) || record.canonicalEventId.length !== 77) throw new TypeError("invalid inbox identity");
  return createHash("sha256").update(record.canonicalEventId).digest("hex");
};

// Claims are permanent dispatch barriers. A crash or ambiguous broker response
// never releases one: recovery is a read-only broker lookup, not another submit.
export class SlackHandoffLedger {
  #directory;
  constructor({ directory } = {}) {
    if (typeof directory !== "string" || !directory) throw new TypeError("ledger directory required");
    this.#directory = resolve(directory);
  }
  async status(record) {
    const key = keyFor(record);
    await this.#checkDirectory();
    const claim = await this.#read(key, "claim");
    const result = await this.#read(key, "result");
    if (result && !claim) throw new Error("orphan handoff result");
    return { key, state: result ? "HANDED_OFF" : claim ? "HANDOFF_UNKNOWN" : "PENDING", workItemId: result?.workItemId ?? null };
  }
  async claim(record) {
    const key = keyFor(record);
    await this.#checkDirectory();
    return this.#publish(key, "claim", { key, state: "CLAIMED" });
  }
  async complete(record, result) {
    const { key, state } = await this.status(record);
    if (state === "PENDING") throw new Error("handoff claim missing");
    if (result?.accepted !== true || typeof result.workItemId !== "string" || result.workItemId.length !== 36 || !UUID.test(result.workItemId)) throw new Error("unverified broker handoff");
    const value = { key, state: "HANDED_OFF", workItemId: result.workItemId };
    if (!(await this.#publish(key, "result", value))) {
      const existing = await this.#read(key, "result");
      if (existing.workItemId !== result.workItemId) throw new Error("conflicting broker handoff");
    }
    return { key, state: "HANDED_OFF", workItemId: result.workItemId };
  }
  async #checkDirectory() {
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("owned private ledger directory required");
  }
  async #read(key, kind) {
    let file;
    try { file = await open(join(this.#directory, `${key}.${kind}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("invalid ledger file");
      const value = JSON.parse(await file.readFile("utf8"));
      if (!value || value.key !== key || !HASH.test(key) || Object.keys(value).length !== (kind === "claim" ? 2 : 3) || value.state !== (kind === "claim" ? "CLAIMED" : "HANDED_OFF") ||
          (kind === "result" && (typeof value.workItemId !== "string" || value.workItemId.length !== 36 || !UUID.test(value.workItemId)))) throw new Error("invalid ledger record");
      return value;
    } finally { await file.close(); }
  }
  async #publish(key, kind, value) {
    const temporary = join(this.#directory, `${key}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    let created = false;
    try {
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, join(this.#directory, `${key}.${kind}.json`)); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; await this.#read(key, kind); }
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      return created;
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
}

export function createSlackInboxWorker({ inbox, ledger, readMessage, getState, broker, timeoutMs = 2_000 } = {}) {
  if (!(inbox instanceof SlackReferenceInbox) || !(ledger instanceof SlackHandoffLedger)) throw new TypeError("inbox and ledger are required");
  if (typeof readMessage !== "function" || typeof getState !== "function" || typeof broker?.handoff !== "function" || typeof broker?.lookup !== "function") throw new TypeError("trusted read, state, and broker adapters required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError("timeoutMs must be 1..30000");
  return Object.freeze({
    async runOnce({ enabled = false, limit = 20, after = null } = {}) {
      if (enabled !== true) return { state: "DISABLED", outcomes: [], nextCursor: null };
      const page = await inbox.list({ limit, after });
      const outcomes = [];
      for (const record of page.records) {
        let claimed = false;
        try {
          const prior = await ledger.status(record);
          if (prior.state === "HANDED_OFF") { outcomes.push({ sourceEvent: record.canonicalEventId, ...prior }); continue; }
          if (prior.state === "HANDOFF_UNKNOWN") {
            claimed = true;
            const found = await bounded(() => broker.lookup({ idempotencyKey: prior.key }), timeoutMs);
            const state = found?.accepted === true ? await ledger.complete(record, found) : prior;
            outcomes.push({ sourceEvent: record.canonicalEventId, ...state });
            continue;
          }
          const observation = await bounded(() => readMessage(record), timeoutMs);
          const event = restoreSlackInboxEvent(record, observation);
          const state = await bounded(() => getState(event), timeoutMs);
          const plan = planSlackCommandIntake(event, state);
          if (plan.shouldDispatch !== true) { outcomes.push({ sourceEvent: record.canonicalEventId, state: plan.state }); continue; }
          // Freeze a snapshot before crossing the asynchronous claim boundary.
          const envelope = freeze(JSON.parse(JSON.stringify(plan)));
          if (!(await ledger.claim(record))) {
            outcomes.push({ sourceEvent: record.canonicalEventId, state: "HANDOFF_UNKNOWN" }); continue;
          }
          claimed = true;
          // The broker MUST atomically recheck current session/policy/approval,
          // claim the exact resource, and durably deduplicate this key before
          // accepting. This worker submits intent; it never executes providers.
          const result = await bounded(() => broker.handoff({ event, plan: envelope, idempotencyKey: prior.key }), timeoutMs);
          const completed = await ledger.complete(record, result);
          outcomes.push({ sourceEvent: record.canonicalEventId, ...completed });
        } catch {
          outcomes.push({ sourceEvent: record.canonicalEventId, state: claimed ? "HANDOFF_UNKNOWN" : "BLOCKED_RECOVERY" });
        }
      }
      return { state: "SCANNED", outcomes, nextCursor: page.nextCursor };
    }
  });
}

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function bounded(invoke, timeoutMs) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(invoke), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker deadline")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
