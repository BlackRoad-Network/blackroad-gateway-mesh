import { constants } from "node:fs";
import { open, link, unlink, readdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { COCKPIT, normalizeSlackEvent, planSlackCommandIntake } from "./slack-control-plane.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const validId = (id) => typeof id === "string" && /^Ev[A-Za-z0-9_-]{1,128}$/.test(id) && !/\s/.test(id);
const validTs = (ts) => typeof ts === "string" && ts.length <= 32 && /^[0-9]+\.[0-9]+$/.test(ts) && !/\s/.test(ts);
const keyFor = (id) => sha256(`slack:${COCKPIT.workspaceId}:${id}`);
const KEYS = ["schema", "workspaceId", "channelId", "providerEventId", "messageTs", "threadTs", "contentHash", "canonicalEventId", "receivedAt"];

// Immutable receipt-side inbox for an owned local Linux filesystem. Provision
// directory privately before starting the server; never use shared/NFS storage.
export class SlackReferenceInbox {
  #directory;
  #clock;

  constructor({ directory, clock = () => new Date().toISOString() } = {}) {
    if (typeof directory !== "string" || !directory) throw new TypeError("inbox directory is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#directory = resolve(directory);
    this.#clock = clock;
  }

  async append(event) {
    // Reject forged/serialized envelopes. Actual request authentication belongs
    // to the signed intake, which is the HTTP server's only source of events.
    if (planSlackCommandIntake(event).state !== "BLOCKED_INBOUND_UNVERIFIED") throw new Error("invalid normalized event");
    const prefix = `road+connector://slack/${COCKPIT.workspaceId}/${COCKPIT.channelId}/`;
    const record = {
      schema: "road-slack-inbox-reference-v1",
      workspaceId: COCKPIT.workspaceId, channelId: COCKPIT.channelId,
      providerEventId: event.source.providerEventId,
      messageTs: event.source.binding.startsWith(prefix) ? event.source.binding.slice(prefix.length) : null,
      threadTs: event.thread, contentHash: event.contentHash,
      canonicalEventId: event.canonicalEventId, receivedAt: this.#clock()
    };
    validateRecord(record);
    await this.#checkDirectory();
    const key = keyFor(record.providerEventId);
    const target = join(this.#directory, `${key}.json`);
    const temporary = join(this.#directory, `${key}.${randomUUID()}.tmp`);
    let duplicate = false;
    let stored = record;
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(`${JSON.stringify(record)}\n`); await file.sync(); }
      finally { await file.close(); }
      try {
        // Publish a fully synced inode only if this event key is absent.
        await link(temporary, target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        stored = await this.#read(key);
        if (KEYS.some((field) => field !== "receivedAt" && stored[field] !== record[field])) throw new Error("inbox event identity conflict");
        duplicate = true;
      }
      // Also sync on the duplicate path: the first writer may have just linked
      // its inode and not yet reached this durability boundary.
      const directory = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      return Object.freeze({ duplicate, record: Object.freeze(stored) });
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async list({ limit = 100, after = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1..100");
    if (after !== null && (typeof after !== "string" || after.length !== 64 || !/^[a-f0-9]+$/.test(after))) throw new TypeError("invalid inbox cursor");
    await this.#checkDirectory();
    const keys = (await readdir(this.#directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => name.slice(0, -5)).sort().filter((key) => after === null || key > after);
    const selected = keys.slice(0, limit);
    const records = [];
    for (const key of selected) records.push(Object.freeze(await this.#read(key)));
    return { records, nextCursor: keys.length > limit ? selected.at(-1) : null };
  }

  async #checkDirectory() {
    const directory = await lstat(this.#directory);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid()) throw new Error("inbox requires an owned private directory");
  }

  async #read(key) {
    const file = await open(join(this.#directory, `${key}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 8_192 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("invalid inbox file");
      const record = JSON.parse(await file.readFile("utf8"));
      validateRecord(record);
      if (keyFor(record.providerEventId) !== key) throw new Error("inbox key mismatch");
      return record;
    } finally { await file.close(); }
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Object.keys(record).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(record, key)) ||
      record.schema !== "road-slack-inbox-reference-v1" || record.workspaceId !== COCKPIT.workspaceId || record.channelId !== COCKPIT.channelId ||
      !validId(record.providerEventId) || !validTs(record.messageTs) || !validTs(record.threadTs) ||
      typeof record.contentHash !== "string" || record.contentHash.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(record.contentHash) ||
      typeof record.receivedAt !== "string" || !Number.isFinite(Date.parse(record.receivedAt)) || new Date(record.receivedAt).toISOString() !== record.receivedAt) throw new Error("invalid inbox record");
  const canonical = sha256(["slack", record.workspaceId, record.channelId, record.providerEventId, record.contentHash.slice(7)].join(":"));
  if (record.canonicalEventId !== `road://event/${canonical}`) throw new Error("invalid inbox event identity");
}

// Call only with a trusted stored record and an authenticated provider read-back.
// A persisted reference cannot grant approval or substitute for provider proof.
export function restoreSlackInboxEvent(record, observation) {
  validateRecord(record);
  if (observation?.workspaceId !== record.workspaceId || observation?.channelId !== record.channelId || observation?.message?.ts !== record.messageTs) throw new Error("inbox observation mismatch");
  if (observation.message.edited !== undefined || observation.message.hidden === true || observation.message.bot_id || observation.message.bot_profile || observation.message.app_id) throw new Error("inbox observation mismatch");
  const event = normalizeSlackEvent({
    ...observation.message, team: observation.workspaceId, channel: observation.channelId, event_id: record.providerEventId
  });
  if (!event.accepted || event.contentHash !== record.contentHash || event.canonicalEventId !== record.canonicalEventId || event.thread !== record.threadTs) throw new Error("inbox observation mismatch");
  return event;
}
