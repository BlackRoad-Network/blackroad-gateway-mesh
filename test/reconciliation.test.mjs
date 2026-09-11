import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DurableReconciliationQueue } from '../src/reconciliation.mjs';
import { ReceiptChain } from '../src/receipt-chain.mjs';
import { createReceipt } from '../src/receipt.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'road-reconciliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000;
  const config = { directory, clock: () => now, graceMs: 10, retryMs: 100, timeoutMs: 500, maxAttempts: 3, ...options };
  return { directory, queue: new DurableReconciliationQueue(config), reopen: () => new DurableReconciliationQueue(config), time: (value) => { now = value; } };
}

function worker(verify = async () => ({ ok: true }), input = {}) {
  return {
    adapters: { slack: { operations: ['write'], execute: () => { assert.fail('worker dispatched a write'); }, verify } },
    resolveContext: async () => ({ id: 'slack', input })
  };
}

test('intent survives reopening, deduplicates context, and emits a linked redacted receipt', async (t) => {
  const { queue, reopen, directory, time } = await fixture(t);
  const contextKey = randomUUID();
  const input = { text: 'private message', token: 'secret-token' };
  await queue.reserve({ id: 'slack', input, contextKey });
  const restored = reopen();
  await assert.rejects(restored.reserve({ id: 'slack', input, contextKey }), /already reserved/);
  assert.deepEqual(await restored.runDue(worker(undefined, input)), []);
  time(1_010);
  const [job] = await restored.runDue(worker(async () => ({ ok: true, detail: 'private provider response' }), input));
  assert.equal(job.status, 'succeeded');
  assert.equal(job.receipt.inputSha256, job.inputSha256);
  assert.equal(job.receipt.reason, 'reconciled-by-read-back');
  const chain = new ReceiptChain();
  chain.append(job.receipt);
  assert.equal(chain.verify().valid, true);
  const raw = await readFile(join(directory, `${contextKey}.json`), 'utf8');
  assert.doesNotMatch(raw, /private|secret-token/);
  assert.equal((await stat(join(directory, `${contextKey}.json`))).mode & 0o777, 0o600);
  assert.deepEqual(await restored.runDue(worker()), []);
});

test('runtime settlement atomically persists the supplied terminal receipt', async (t) => {
  const { queue, reopen } = await fixture(t);
  const contextKey = randomUUID();
  const input = { text: 'private message', token: 'secret-token' };
  await queue.reserve({ id: 'slack', input, contextKey });
  const receipt = createReceipt({
    id: 'slack', operation: 'write', status: 'failed',
    reason: 'read-after-write-verification-failed', input,
    verification: { ok: false, detail: null }, timestamp: '2026-09-11T01:02:03.000Z'
  });

  await queue.settle(contextKey, 'failed', receipt);
  const [persisted] = await reopen().list();
  assert.equal(persisted.status, 'failed');
  assert.deepEqual(persisted.receipt, receipt);
  assert.doesNotMatch(JSON.stringify(persisted), /private message|secret-token/);
});

test('negative and thrown read-backs back off then stop for manual review', async (t) => {
  const { queue, time } = await fixture(t);
  const contextKey = randomUUID();
  await queue.reserve({ id: 'slack', input: {}, contextKey });
  await queue.settle(contextKey, 'unknown');
  let calls = 0;
  const options = worker(async () => { calls += 1; if (calls === 2) throw new Error('token=secret'); return { ok: 'true' }; });
  assert.deepEqual(await queue.runDue(options), []);
  time(1_010);
  let [job] = await queue.runDue(options);
  assert.equal(job.nextAttemptAt, 1_110);
  assert.equal(job.status, 'pending');
  assert.deepEqual(await queue.runDue(options), []);
  time(1_110);
  [job] = await queue.runDue(options);
  assert.equal(job.nextAttemptAt, 1_310);
  time(1_310);
  [job] = await queue.runDue(options);
  assert.equal(job.status, 'manual-review');
  assert.equal(job.receipt, null);
  assert.equal(job.attempts, 3);
  time(10_000);
  assert.deepEqual(await queue.runDue(options), []);
  assert.equal(calls, 3);
});

test('unknown writes retain their initial grace before a single reconciliation attempt', async (t) => {
  const { queue, time } = await fixture(t, { graceMs: 50, maxAttempts: 1 });
  const contextKey = randomUUID();
  await queue.reserve({ id: 'slack', input: {}, contextKey });
  await queue.settle(contextKey, 'unknown');
  let calls = 0;
  const options = worker(async () => { calls += 1; return { ok: true }; });
  assert.deepEqual(await queue.runDue(options), []);
  time(1_049);
  assert.deepEqual(await queue.runDue(options), []);
  assert.equal(calls, 0);
  time(1_050);
  const [job] = await queue.runDue(options);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempts, 1);
  assert.equal(calls, 1);
});

test('wrong target or input is quarantined before provider verification', async (t) => {
  const { queue, time } = await fixture(t);
  let due = 1_010;
  for (const context of [{ id: 'github', input: {} }, { id: 'slack', input: { altered: true } }]) {
    const contextKey = randomUUID();
    await queue.reserve({ id: 'slack', input: {}, contextKey });
    await queue.settle(contextKey, 'unknown');
    const options = worker(() => assert.fail('mismatched context reached provider'));
    options.resolveContext = async () => context;
    time(due);
    due += 10;
    const [job] = await queue.runDue(options);
    assert.equal(job.status, 'manual-review');
    assert.equal(job.history.at(-1).event, 'context-mismatch');
  }
  time(100_000);
  assert.deepEqual(await queue.runDue(worker()), []);
});

test('a process exiting inside verification leaves a recoverable expiring lease', async (t) => {
  const { queue, directory, reopen, time } = await fixture(t);
  const contextKey = randomUUID();
  await queue.reserve({ id: 'slack', input: {}, contextKey });
  const moduleUrl = new URL('../src/reconciliation.mjs', import.meta.url).href;
  const script = `import { DurableReconciliationQueue } from ${JSON.stringify(moduleUrl)};
    const queue = new DurableReconciliationQueue({directory: process.argv[1], clock: () => 1010, timeoutMs: 20});
    await queue.runDue({resolveContext: async () => ({id:'slack',input:{}}),
      adapters:{slack:{operations:['write'],execute:()=>{throw new Error('write forbidden')},verify:()=>process.exit(0)}}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr);
  const restored = reopen();
  const [claimed] = await restored.list();
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  time(2_029);
  assert.deepEqual(await restored.runDue(worker()), []);
  time(2_030);
  const [job] = await restored.runDue(worker());
  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempts, 2);
});

test('competing queue instances claim one read-back and preserve terminal state', async (t) => {
  const { queue, reopen, time } = await fixture(t);
  const contextKey = randomUUID();
  await queue.reserve({ id: 'slack', input: {}, contextKey });
  time(1_010);
  let calls = 0;
  const options = worker(async () => { calls += 1; return { ok: true }; });
  const results = await Promise.all([queue.runDue(options), reopen().runDue(options)]);
  assert.equal(calls, 1);
  assert.equal(results.flat().length, 1);
  await queue.settle(contextKey, 'unknown');
  assert.equal((await queue.list())[0].status, 'succeeded');
});

test('hanging read-backs are bounded and a late success cannot rewrite persisted outcome', async (t) => {
  const { queue, time } = await fixture(t, { maxAttempts: 1, timeoutMs: 20 });
  await queue.reserve({ id: 'slack', input: {}, contextKey: randomUUID() });
  time(1_010);
  let release;
  const [job] = await queue.runDue(worker(() => new Promise((resolve) => { release = resolve; })));
  assert.equal(job.status, 'manual-review');
  release({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await queue.list())[0].status, 'manual-review');
});

test('corrupt records and an existing transaction lock fail closed', async (t) => {
  const { queue, directory } = await fixture(t);
  const contextKey = randomUUID();
  await writeFile(join(directory, `${contextKey}.lock`), '');
  await assert.rejects(queue.reserve({ id: 'slack', input: {}, contextKey }), { code: 'EEXIST' });
  await rm(join(directory, `${contextKey}.lock`));
  await writeFile(join(directory, `${contextKey}.json`), '{"schema":"broken"}');
  await assert.rejects(queue.runDue(worker()), /invalid reconciliation job/);
  await assert.rejects(queue.reserve({ id: 'slack', input: {}, contextKey: '../escape' }), /UUID/);
});

test('missing context retries and a resolver completing after timeout never reaches the provider', async (t) => {
  const { queue, time } = await fixture(t, { timeoutMs: 20 });
  await queue.reserve({ id: 'slack', input: {}, contextKey: randomUUID() });
  time(1_010);
  const options = worker(() => assert.fail('expired context reached provider'));
  options.resolveContext = async () => null;
  assert.equal((await queue.runDue(options))[0].status, 'pending');
  time(1_110);
  let release;
  options.resolveContext = () => new Promise((resolve) => { release = resolve; });
  assert.equal((await queue.runDue(options))[0].status, 'pending');
  release({ id: 'slack', input: {} });
  await new Promise((resolve) => setImmediate(resolve));
});

test('an expired reader cannot overwrite a newer lease completion', async (t) => {
  const { queue, reopen, time } = await fixture(t, { timeoutMs: 1_000 });
  const contextKey = randomUUID();
  await queue.reserve({ id: 'slack', input: {}, contextKey });
  time(1_010);
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const first = queue.runDue(worker(() => new Promise((resolve) => { release = resolve; started(); })));
  await ready;
  time(3_010);
  const [newer] = await reopen().runDue(worker());
  assert.equal(newer.status, 'succeeded');
  release({ ok: false });
  const [older] = await first;
  assert.equal(older.status, 'succeeded');
  assert.equal((await queue.list())[0].history.at(-1).event, 'read-back-confirmed');
});

test('worker honors batch limits and validates settings before invoking providers', async (t) => {
  const { queue, time, directory } = await fixture(t);
  for (let i = 0; i < 3; i += 1) await queue.reserve({ id: 'slack', input: {}, contextKey: randomUUID() });
  time(1_010);
  assert.equal((await queue.runDue({ ...worker(), limit: 2 })).length, 2);
  assert.equal((await queue.runDue(worker())).length, 1);
  await assert.rejects(queue.runDue({ ...worker(), limit: 0 }), /limit/);
  assert.throws(() => new DurableReconciliationQueue({ directory, timeoutMs: 0 }), /durations/);
});
