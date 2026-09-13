import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { COCKPIT, normalizeSlackEvent } from "./slack-control-plane.mjs";
import { SlackReferenceInbox } from "./slack-reference-inbox.mjs";
import { SlackHandoffLedger, createSlackInboxWorker } from "./slack-inbox-worker.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "road-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inboxPath = join(directory, "inbox"), ledgerPath = join(directory, "ledger");
  await mkdir(inboxPath, { mode: 0o700 }); await mkdir(ledgerPath, { mode: 0o700 });
  const inbox = new SlackReferenceInbox({ directory: inboxPath });
  const ledger = new SlackHandoffLedger({ directory: ledgerPath });
  const message = { user: COCKPIT.operatorUserId, channel: COCKPIT.channelId, ts: "1788943756.716919", text: "road run private-plan-1729" };
  const event = normalizeSlackEvent({ ...message, event_id: "EvWorker1729" });
  await inbox.append(event);
  const record = (await inbox.list()).records[0];
  const accepted = { accepted: true, workItemId: randomUUID() };
  const config = {
    inbox, ledger,
    readMessage: async () => ({ workspaceId: COCKPIT.workspaceId, channelId: COCKPIT.channelId, message }),
    getState: async (event) => ({ inboundSubscriptionVerified: true,
      resolvedPlansById: { "private-plan-1729": { id: "private-plan-1729", actionClass: "WRITE", resourceKey: "private-resource", risk: [], planHash: "sha256:" + "a".repeat(64) } },
      approval: { approved: true, canonicalEventId: event.canonicalEventId, contentHash: event.contentHash, threadTs: event.thread, planHash: "sha256:" + "a".repeat(64) }
    }),
    broker: { handoff: async () => accepted, lookup: async () => accepted }
  };
  return { config, directory, inboxPath, ledgerPath, event, record, accepted };
}

test("worker is disabled by default without reading provider or broker", async (t) => {
  const { config } = await fixture(t);
  config.readMessage = () => assert.fail("disabled worker read provider");
  assert.equal((await createSlackInboxWorker(config).runOnce()).state, "DISABLED");
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: "true" })).state, "DISABLED");
});

test("approved handoff persists references and is not repeated after reopening", async (t) => {
  const { config, ledgerPath, accepted } = await fixture(t);
  let calls = 0;
  config.broker.handoff = async ({ plan, idempotencyKey }) => {
    calls++; assert.equal(plan.resolvedPlanHash, "sha256:" + "a".repeat(64));
    assert.match(idempotencyKey, /^[a-f0-9]{64}$/);
    assert.throws(() => { plan.exactTarget = "altered"; }, TypeError);
    return accepted;
  };
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: true })).outcomes[0].state, "HANDED_OFF");
  const reopened = new SlackHandoffLedger({ directory: ledgerPath });
  const repeated = await createSlackInboxWorker({ ...config, ledger: reopened, readMessage: () => assert.fail("completed event reread") }).runOnce({ enabled: true });
  assert.equal(repeated.outcomes[0].workItemId, accepted.workItemId);
  assert.equal(calls, 1);
  for (const name of await readdir(ledgerPath)) assert.doesNotMatch(await readFile(join(ledgerPath, name), "utf8"), /private-plan|private-resource|road run|approved/);
});

test("competing workers submit one broker handoff", async (t) => {
  const { config, ledgerPath, accepted } = await fixture(t);
  let calls = 0;
  config.broker.handoff = async () => { calls++; return accepted; };
  await Promise.all(Array.from({ length: 8 }, () => createSlackInboxWorker({ ...config, ledger: new SlackHandoffLedger({ directory: ledgerPath }) }).runOnce({ enabled: true })));
  assert.equal(calls, 1);
});

test("missing approval or a changed plan hash never consumes a dispatch claim", async (t) => {
  const { config, record } = await fixture(t);
  const original = config.getState;
  config.broker.handoff = () => assert.fail("unauthorized handoff");
  for (const patch of [undefined, { approved: true }]) {
    config.getState = async (event) => ({ ...await original(event), approval: patch });
    const result = await createSlackInboxWorker(config).runOnce({ enabled: true });
    assert.equal(result.outcomes[0].state, "AWAITING_AUTHORIZATION");
    assert.equal((await config.ledger.status(record)).state, "PENDING");
  }
  config.getState = async (event) => {
    const state = await original(event); state.resolvedPlansById["private-plan-1729"].planHash = "sha256:" + "b".repeat(64); return state;
  };
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: true })).outcomes[0].state, "AWAITING_AUTHORIZATION");
});

test("mismatched or unavailable provider read-back blocks handoff without leaking errors", async (t) => {
  const { config, record } = await fixture(t);
  const original = config.readMessage;
  config.broker.handoff = () => assert.fail("changed source handed off");
  config.readMessage = async () => { const value = await original(); return { ...value, message: { ...value.message, text: "road run different" } }; };
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: true })).outcomes[0].state, "BLOCKED_RECOVERY");
  config.readMessage = async () => { throw new Error("token=private-error-value"); };
  const result = await createSlackInboxWorker(config).runOnce({ enabled: true });
  assert.doesNotMatch(JSON.stringify(result), /private-error|token/);
  assert.equal((await config.ledger.status(record)).state, "PENDING");
});

test("ambiguous handoff remains claimed and reconciles by lookup after restart", async (t) => {
  const { config, ledgerPath, accepted } = await fixture(t);
  let writes = 0, lookups = 0;
  config.broker.handoff = async () => { writes++; throw new Error("response lost after acceptance"); };
  const first = await createSlackInboxWorker(config).runOnce({ enabled: true });
  assert.equal(first.outcomes[0].state, "HANDOFF_UNKNOWN");
  config.broker.lookup = async () => { lookups++; return accepted; };
  const second = await createSlackInboxWorker({ ...config, ledger: new SlackHandoffLedger({ directory: ledgerPath }), readMessage: () => assert.fail("recovery must only lookup") }).runOnce({ enabled: true });
  assert.equal(second.outcomes[0].state, "HANDED_OFF");
  assert.equal(writes, 1); assert.equal(lookups, 1);
});

test("an interrupted pre-submit claim is never automatically resubmitted", async (t) => {
  const { config, record, ledgerPath } = await fixture(t);
  await config.ledger.claim(record);
  config.broker.handoff = () => assert.fail("crashed claim was replayed");
  config.broker.lookup = async () => ({ accepted: false });
  const result = await createSlackInboxWorker({ ...config, ledger: new SlackHandoffLedger({ directory: ledgerPath }) }).runOnce({ enabled: true });
  assert.equal(result.outcomes[0].state, "HANDOFF_UNKNOWN");
});

test("timeouts before a claim cannot hand off when late context arrives", async (t) => {
  const { config, record } = await fixture(t);
  let release;
  const original = config.readMessage;
  config.readMessage = () => new Promise((resolve) => { release = resolve; });
  config.broker.handoff = () => assert.fail("late context triggered handoff");
  const result = await createSlackInboxWorker({ ...config, timeoutMs: 10 }).runOnce({ enabled: true });
  assert.equal(result.outcomes[0].state, "BLOCKED_RECOVERY");
  release(await original()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await config.ledger.status(record)).state, "PENDING");
});

test("broker timeouts and result-persistence failure remain unknown without repeat submit", async (t) => {
  const { config, accepted } = await fixture(t);
  let release, calls = 0;
  config.broker.handoff = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  assert.equal((await createSlackInboxWorker({ ...config, timeoutMs: 10 }).runOnce({ enabled: true })).outcomes[0].state, "HANDOFF_UNKNOWN");
  release(accepted);
  config.ledger.complete = async () => { throw new Error("disk unavailable"); };
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: true })).outcomes[0].state, "HANDOFF_UNKNOWN");
  assert.equal(calls, 1);
});

test("missing durable storage prevents broker submission", async (t) => {
  const { config, ledgerPath } = await fixture(t);
  await rm(ledgerPath, { recursive: true });
  config.broker.handoff = () => assert.fail("handoff without a durable claim");
  assert.equal((await createSlackInboxWorker(config).runOnce({ enabled: true })).outcomes[0].state, "BLOCKED_RECOVERY");
});
