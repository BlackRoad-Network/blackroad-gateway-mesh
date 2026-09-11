import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStateStore } from "../lib/store.mjs";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "road-store-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state", "state.json");
  const eventsPath = join(dir, "events", "events.jsonl");
  await mkdir(join(dir, "events"));
  const store = new JsonStateStore({ statePath, eventsPath, lockTimeoutMs: 100 });
  return { dir, statePath, eventsPath, store };
}
const metadata = { actor: "agent-instance-4", type: "test.commit" };
const increment = (state) => { state.count = (state.count ?? 0) + 1; return state.count; };
const lines = async (path) => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

test("missing log directory blocks before mutation", async (t) => {
  const { dir, store } = await fixture(t);
  await rm(join(dir, "events"), { recursive: true });
  let calls = 0;
  await assert.rejects(store.transact(metadata, () => { calls++; }), /ENOENT/);
  assert.equal(calls, 0);
  assert.equal((await store.read()).generation, 0);
});

test("post-commit log failure recovers on restart without repeating work", async (t) => {
  const { dir, store, statePath, eventsPath } = await fixture(t);
  const result = await store.transact(metadata, async (state) => {
    await rename(join(dir, "events"), join(dir, "events-offline"));
    return increment(state);
  });
  assert.equal(result.committed, true);
  assert.equal(result.eventLogPending, true);
  assert.equal(result.result, 1);
  const reopened = new JsonStateStore({ statePath, eventsPath });
  let called = false;
  await assert.rejects(reopened.transact(metadata, () => { called = true; }), /ENOENT/);
  assert.equal(called, false);
  await rename(join(dir, "events-offline"), join(dir, "events"));
  await reopened.reconcileEvents();
  await reopened.reconcileEvents();
  assert.equal((await lines(eventsPath)).length, 1);
  assert.equal((await reopened.read()).count, 1);
  await reopened.transact(metadata, increment);
  assert.equal((await reopened.read()).count, 2);
  assert.equal((await lines(eventsPath)).length, 2);
});

test("missing log tail is restored once", async (t) => {
  const { store, statePath, eventsPath } = await fixture(t);
  await store.transact(metadata, increment);
  const first = await readFile(eventsPath, "utf8");
  await store.transact(metadata, increment);
  await writeFile(eventsPath, first);
  const reopened = new JsonStateStore({ statePath, eventsPath });
  await reopened.reconcileEvents();
  const events = await lines(eventsPath);
  assert.equal(events.length, 2);
  assert.equal(events[1].previousHash, events[0].hash);
  assert.equal((await reopened.read()).count, 2);
});

for (const damage of ["truncated", "conflicting", "ahead", "gap"]) {
  test(`damaged history stays blocked: ${damage}`, async (t) => {
    const { store, statePath, eventsPath } = await fixture(t);
    await store.transact(metadata, increment);
    const raw = await readFile(eventsPath, "utf8");
    if (damage === "truncated") await writeFile(eventsPath, raw.slice(0, -3));
    if (damage === "conflicting") await writeFile(eventsPath, raw.replace("test.commit", "test.changed"));
    if (damage === "ahead") await writeFile(eventsPath, raw + raw);
    if (damage === "gap") {
      const state = await store.read();
      state.events = [];
      await writeFile(statePath, JSON.stringify(state));
      await writeFile(eventsPath, "");
    }
    let called = false;
    await assert.rejects(store.transact(metadata, () => { called = true; }), /event-log-/);
    assert.equal(called, false);
    assert.equal((await store.read()).generation, 1);
  });
}

test("concurrent initialization preserves every generation", async (t) => {
  const { statePath, eventsPath, store } = await fixture(t);
  const stores = Array.from({ length: 8 }, () => new JsonStateStore({ statePath, eventsPath }));
  await Promise.all(stores.map(async (instance) => { await instance.init(); await instance.transact(metadata, increment); }));
  assert.equal((await store.read()).count, 8);
  assert.deepEqual((await lines(eventsPath)).map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("old lock is not stolen", async (t) => {
  const { store, statePath } = await fixture(t);
  await store.init();
  await writeFile(statePath + ".lock", "owner");
  await utimes(statePath + ".lock", new Date(0), new Date(0));
  await assert.rejects(store.transact(metadata, increment), /collaboration-state-contention/);
  assert.equal(await readFile(statePath + ".lock", "utf8"), "owner");
  assert.equal((await store.read()).generation, 0);
});

test("state and log paths cannot alias", () => {
  assert.throws(() => new JsonStateStore({ statePath: "/tmp/example/state", eventsPath: "/tmp/example/./state" }), /event-log-path-conflict/);
});

test("state rename failure leaves no new log event", async (t) => {
  const { store, statePath, eventsPath } = await fixture(t);
  await assert.rejects(store.transact(metadata, async (state) => {
    await mkdir(statePath);
    return increment(state);
  }));
  assert.equal((await lines(eventsPath)).length, 0);
  await rm(statePath, { recursive: true });
  assert.equal((await store.read()).generation, 0);
  await store.transact(metadata, increment);
  assert.equal((await store.read()).count, 1);
});
