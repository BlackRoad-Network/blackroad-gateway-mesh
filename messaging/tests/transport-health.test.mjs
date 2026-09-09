import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTransport, probePing, probeTcp, probeDns, probeHttp, probeRNode, probeTailscale } from '../transport-health.mjs';

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
