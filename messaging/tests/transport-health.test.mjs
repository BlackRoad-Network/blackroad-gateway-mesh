import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeTransport, probePing, probeTcp, probeDns, probeHttp, probeRNode, probeTailscale, runCommand } from '../transport-health.mjs';

async function fakePath(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'road-transport-health-'));
  const original = process.env.PATH;
  for (const [name, body] of Object.entries(files)) {
    const path = join(directory, name);
    await writeFile(path, body);
    await chmod(path, 0o700);
  }
  process.env.PATH = directory;
  t.after(async () => { process.env.PATH = original; await rm(directory, { recursive: true, force: true }); });
}

test('rejects unknown probe kinds', async () => {
  await assert.rejects(() => probeTransport({ kind: 'warp-drive' }), (error) => error.code === 'PROBE_KIND_UNSUPPORTED');
});

test('ping requires a target', async () => {
  await assert.rejects(() => probePing({}), (error) => error.code === 'TARGET_REQUIRED');
});

test('tcp validates port', async () => {
  await assert.rejects(() => probeTcp({ target: '127.0.0.1', port: 70000 }), (error) => error.code === 'PORT_REQUIRED');
});

test('dns resolves localhost without claiming service health', async () => {
  const result = await probeDns({ target: 'localhost' });
  assert.equal(result.state, 'RESOLVED');
  assert.ok(result.addresses.length >= 1);
});

test('http probe classifies a checker transport failure without throwing', async () => {
  const result = await probeHttp({ url: 'http://127.0.0.1:1/', timeoutMs: 500 });
  assert.ok(['CHECKER_TRANSPORT_ERROR', 'TIMEOUT_UNKNOWN'].includes(result.state));
});

test('rnode probe is evidence-sensitive when hardware/tools are absent', async () => {
  const result = await probeRNode({ timeoutMs: 500 });
  assert.equal(result.probe, 'rnode');
  assert.ok(['VERIFIED','TIMEOUT_UNKNOWN','NO_SERIAL_CANDIDATE','TOOLS_AND_SERIAL_NOT_OBSERVED','SERIAL_PRESENT_TOOL_MISSING','SERIAL_CANDIDATE_NOT_VERIFIED'].includes(result.state));
});

test('tailscale probe does not convert missing client into offline peer', async () => {
  const result = await probeTailscale({ timeoutMs: 500 });
  assert.equal(result.probe, 'tailscale');
  assert.notEqual(result.state, 'OFFLINE');
});

test('tailscale parses complete status JSON larger than diagnostic tails', async (t) => {
  const peers = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`peer-${index}`, { Online: true }]));
  const status = JSON.stringify({ BackendState: 'Running', Self: { Online: true, DNSName: 'node.tailnet.ts.net' }, Peer: peers });
  await fakePath(t, { tailscale: `#!${process.execPath}\nif (process.argv[2] === 'status') process.stdout.write(${JSON.stringify(status)});\n` });
  const result = await probeTailscale({ timeoutMs: 500 });
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.peerCount, 80);
});

test('command timeout escalates from SIGTERM and always settles', async (t) => {
  await fakePath(t, { stubborn: `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n` });
  const started = Date.now();
  const result = await runCommand(join(process.env.PATH, 'stubborn'), [], { timeoutMs: 20, killGraceMs: 20 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 500);
});

test('synchronous spawn failures become bounded command evidence', async () => {
  const result = await runCommand(null, [], { timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.match(result.stderr, /TypeError|string/);
});

test('rnstatus timeout remains unknown when no serial candidate exists', async (t) => {
  await fakePath(t, { rnstatus: `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n` });
  const result = await probeRNode({ timeoutMs: 20 });
  assert.equal(result.state, 'TIMEOUT_UNKNOWN');
  assert.equal(result.evidence[0].timedOut, true);
});

test('rnode accepts a serial device separately from numeric TCP ports', async (t) => {
  await fakePath(t, { rnodeconf: `#!${process.execPath}\nprocess.stdout.write('RNode verified');\n` });
  const result = await probeRNode({ serialDevice: '/dev/cu.usbmodem-road', timeoutMs: 500 });
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.port, '/dev/cu.usbmodem-road');
});

test('integration contract keeps serial devices separate from numeric ports', async () => {
  const patch = await readFile(new URL('../../transport-health-v1.9-integration.patch', import.meta.url), 'utf8');
  assert.match(patch, /serialDevice: flags\['serial-device'\]/);
  assert.match(patch, /serialDevice: \{ type: \['string','null'\] \}/);
  assert.match(patch, /port: \{ type: \['integer','null'\], minimum: 1, maximum: 65535 \}/);
});
