import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, readdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COCKPIT, planSlackCommandIntake } from "./slack-control-plane.mjs";
import { createSlackRequestIntake } from "./slack-request-intake.mjs";
import { createSlackIngressServer } from "./slack-http-server.mjs";
import { SlackReferenceInbox, restoreSlackInboxEvent } from "./slack-reference-inbox.mjs";

const NOW = 1_788_943_756_000;
const SECRET = "local-http-test-signing-secret";
const APP = "ATEST1729";
const config = { signingSecret: SECRET, applicationId: APP, clock: () => NOW };
function payload(id = "EvHTTP1729", text = "road run private-plan-1729") {
  return {
    type: "event_callback", team_id: COCKPIT.workspaceId, api_app_id: APP, event_id: id,
    event: { type: "message", user: COCKPIT.operatorUserId, channel: COCKPIT.channelId,
      ts: "1788943756.716919", thread_ts: "1788943700.123456", text }
  };
}
function signed(data = payload()) {
  const body = Buffer.from(JSON.stringify(data));
  const timestamp = String(NOW / 1_000);
  return {
    body, headers: {
      "Content-Type": "application/json", "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${timestamp}:`).update(body).digest("hex")
    }
  };
}
const normalized = (data) => {
  const { body, headers } = signed(data);
  return createSlackRequestIntake(config).handle({ method: "POST", rawBody: body, headers }).event;
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "road-slack-http-"));
  const inbox = new SlackReferenceInbox({ directory });
  const server = createSlackIngressServer({ ...config, inbox, ...options });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, inbox, server, port: server.address().port };
}

function send(port, { body, headers } = signed(), options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/slack/events", method: "POST", headers, ...options }, (res) => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", (part) => { text += part; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("real HTTP intake persists a private reference before acknowledging, then restores with read-back", async (t) => {
  const { inbox, directory, port } = await fixture(t);
  const result = await send(port);
  assert.equal(result.status, 200);
  assert.equal(result.text, "ok");
  const restarted = new SlackReferenceInbox({ directory });
  const { records } = await restarted.list();
  assert.equal(records.length, 1);
  const [name] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const raw = await readFile(join(directory, name), "utf8");
  assert.doesNotMatch(raw, /private-plan|local-http-test-signing|road run/);
  assert.equal(records[0].threadTs, payload().event.thread_ts);
  const restored = restoreSlackInboxEvent(records[0], { workspaceId: COCKPIT.workspaceId, channelId: COCKPIT.channelId, message: payload().event });
  assert.equal(planSlackCommandIntake(restored, { inboundSubscriptionVerified: true }).state, "AWAITING_AUTHORIZATION");
  assert.deepEqual(await inbox.list(), await restarted.list());
});

test("concurrent signed redeliveries and a new inbox instance retain one original reference", async (t) => {
  const { inbox, directory, port } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => send(port)));
  assert.ok(results.every((result) => result.status === 200));
  const before = await inbox.list();
  assert.equal(before.records.length, 1);
  const later = new SlackReferenceInbox({ directory, clock: () => "2026-09-11T01:00:00.000Z" });
  const duplicate = await later.append(normalized(payload()));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.receivedAt, before.records[0].receivedAt);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("the same provider event ID with changed content or thread cannot replace history", async (t) => {
  const { port, inbox } = await fixture(t);
  assert.equal((await send(port)).status, 200);
  const before = await inbox.list();
  for (const data of [payload("EvHTTP1729", "road run different-plan"), { ...payload(), event: { ...payload().event, thread_ts: "1788943600.000001" } }]) {
    assert.equal((await send(port, signed(data))).status, 503);
    assert.deepEqual(await inbox.list(), before);
  }
});

test("missing or nonprivate inbox storage returns 503 instead of losing acknowledged work", async (t) => {
  const { directory, inbox, port } = await fixture(t);
  await rm(directory, { recursive: true });
  assert.equal((await send(port)).status, 503);
  await assert.rejects(inbox.list(), { code: "ENOENT" });
  const other = await fixture(t);
  await chmod(other.directory, 0o755);
  assert.equal((await send(other.port)).status, 503);
  assert.deepEqual(await readdir(other.directory), []);
});

test("the response waits for persistence and a storage timeout can be retried without duplication", async (t) => {
  const { inbox, port } = await fixture(t, { requestTimeoutMs: 100 });
  const append = inbox.append.bind(inbox);
  let release;
  let began;
  let stored;
  const storageFinished = new Promise((resolve) => { stored = resolve; });
  const ready = new Promise((resolve) => { began = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  inbox.append = async (event) => { began(); await gate; const result = await append(event); stored(); return result; };
  let responded = false;
  const pending = send(port).then((result) => { responded = true; return result; });
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responded, false);
  assert.equal((await pending).status, 503);
  inbox.append = append;
  release();
  assert.equal((await send(port)).status, 200);
  await storageFinished;
  assert.equal((await inbox.list()).records.length, 1);
});

test("invalid signatures, wrong routes, and URL challenges never create inbox records", async (t) => {
  const { port, inbox } = await fixture(t);
  const forged = signed(); forged.headers["X-Slack-Signature"] = "v0=" + "0".repeat(64);
  assert.equal((await send(port, forged)).status, 401);
  assert.equal((await send(port, signed(), { path: "/other" })).status, 404);
  assert.equal((await send(port, signed(), { method: "GET" })).status, 405);
  const challenge = await send(port, signed({ type: "url_verification", challenge: "signed-challenge-1729" }));
  assert.equal(challenge.status, 200);
  assert.equal(challenge.text, "signed-challenge-1729");
  assert.equal((await inbox.list()).records.length, 0);
});

test("HTTP enforces actual streamed bytes as well as declared length", async (t) => {
  const { port, inbox } = await fixture(t, { maxBodyBytes: 100 });
  const large = signed();
  large.headers["Transfer-Encoding"] = "chunked";
  assert.equal((await send(port, large)).status, 413); // Chunked transfer, no Content-Length.
  delete large.headers["Transfer-Encoding"];
  large.headers["Content-Length"] = String(large.body.length);
  assert.equal((await send(port, large)).status, 413);
  assert.equal((await inbox.list()).records.length, 0);
});

test("slow incomplete requests hit the body deadline and never enqueue", async (t) => {
  const { port, inbox } = await fixture(t, { requestTimeoutMs: 100 });
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/slack/events", method: "POST", headers: signed().headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.write("{"); // Never end the body.
  });
  assert.equal(result, 408);
  assert.equal((await inbox.list()).records.length, 0);
});

test("duplicate signing headers and compressed bodies are rejected at the HTTP boundary", async (t) => {
  const { port, inbox } = await fixture(t);
  const duplicate = signed(); duplicate.headers["X-Slack-Signature"] = [duplicate.headers["X-Slack-Signature"], duplicate.headers["X-Slack-Signature"]];
  assert.equal((await send(port, duplicate)).status, 400);
  const compressed = signed(); compressed.headers["Content-Encoding"] = "gzip";
  assert.equal((await send(port, compressed)).status, 415);
  assert.equal((await inbox.list()).records.length, 0);
});

test("recovery rejects changed content, authors, message timestamps, and thread bindings", async (t) => {
  const { port, inbox } = await fixture(t);
  await send(port);
  const [record] = (await inbox.list()).records;
  const observation = { workspaceId: COCKPIT.workspaceId, channelId: COCKPIT.channelId, message: payload().event };
  for (const patch of [{ text: "road run changed" }, { user: "UOTHER" }, { ts: "1788943756.999999" }, { thread_ts: "1788943700.654321" }, { subtype: "message_changed" }, { edited: { ts: "1788943999.123456" } }, { hidden: true }]) {
    assert.throws(() => restoreSlackInboxEvent(record, { ...observation, message: { ...observation.message, ...patch } }), /observation mismatch/);
  }
  assert.throws(() => restoreSlackInboxEvent(record, { ...observation, channelId: "COTHER" }), /observation mismatch/);
});

test("bounded inbox paging survives orphan temporary files and fails on damaged records", async (t) => {
  const { inbox, directory } = await fixture(t);
  for (let index = 0; index < 3; index++) await inbox.append(normalized(payload(`EvPage${index}`)));
  await writeFile(join(directory, "orphan.tmp"), "incomplete");
  const first = await inbox.list({ limit: 2 });
  assert.equal(first.records.length, 2);
  const second = await inbox.list({ limit: 2, after: first.nextCursor });
  assert.equal(second.records.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map((record) => record.providerEventId)).size, 3);
  const [name] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  await writeFile(join(directory, name), "{}", { mode: 0o600 });
  await assert.rejects(inbox.list(), /invalid inbox record/);
});

test("unbound server construction performs no writes or network startup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "road-slack-unbound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inbox = new SlackReferenceInbox({ directory });
  const server = createSlackIngressServer({ ...config, inbox });
  assert.equal(server.listening, false);
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => createSlackIngressServer(config), /SlackReferenceInbox/);
  assert.throws(() => createSlackIngressServer({ ...config, inbox, requestTimeoutMs: 3_000 }), /requestTimeoutMs/);
  await assert.rejects(inbox.append(JSON.parse(JSON.stringify(normalized(payload())))), /invalid normalized event/);
});
