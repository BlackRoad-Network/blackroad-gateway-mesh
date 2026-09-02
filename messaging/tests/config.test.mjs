import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROFILE_ROOT = join(ROOT, 'mcp', 'claude');
const LAUNCHER = join(ROOT, 'launch-agent-mcp.sh');
const EXPECTED = [
  'agent-instance-1',
  'agent-instance-2',
  'agent-instance-3',
  'agent-instance-4',
  'agent-instance-5',
  'agent-instance-6',
  'connector-orchestrator',
];

async function loadProfiles() {
  const names = (await readdir(PROFILE_ROOT))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const entries = [];
  for (const name of names) {
    entries.push({ name, value: JSON.parse(await readFile(join(PROFILE_ROOT, name), 'utf8')) });
  }
  return entries;
}

async function dynamicSessionRef(stateRoot, agentId) {
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'messaging_agent_status', arguments: {} },
  });
  const child = spawn('/bin/bash', [LAUNCHER, agentId], {
    cwd: ROOT,
    env: {
      ...process.env,
      ROAD_WORKSPACE_ROOT: dirname(dirname(dirname(stateRoot))),
      ROAD_MESSAGING_STATE_ROOT: stateRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.write(`${request}\n`);

  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('launcher MCP response timeout')), 4000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      setTimeout(resolvePromise, 40);
    });
  });
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => child.once('close', resolvePromise));

  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
  const response = JSON.parse(Buffer.concat(stdout).toString('utf8').trim().split('\n')[0]);
  return response.result.structuredContent.actor.sessionRef;
}

test('ships exactly seven Claude messaging profiles', async () => {
  const profiles = await loadProfiles();
  assert.deepEqual(profiles.map(({ name }) => name), EXPECTED.map((id) => `${id}.json`).sort());
});

test('every profile launches the canonical workspace runtime under its filename identity', async () => {
  const profiles = await loadProfiles();
  for (const { name, value } of profiles) {
    const id = name.replace(/\.json$/, '');
    const server = value.mcpServers?.['blackroad-messaging'];
    assert.ok(server, `${name} lacks blackroad-messaging`);
    assert.equal(server.command, '/bin/bash');
    assert.deepEqual(server.args, [
      '/Users/alexa/workspace/system/messaging/launch-agent-mcp.sh',
      id,
    ]);
    assert.equal(server.env.ROAD_WORKSPACE_ROOT, '/Users/alexa/workspace');
    assert.equal(Object.hasOwn(server.env, 'ROAD_SESSION_REF'), false);
    assert.equal(Object.hasOwn(server.env, 'ROAD_SLACK_SIGNING_SECRET'), false);
    assert.equal(Object.hasOwn(server.env, 'ROAD_GITHUB_WEBHOOK_SECRET'), false);
  }
});

test('launcher rejects identities outside the seven stable actors', () => {
  const result = spawnSync('/bin/bash', [LAUNCHER, 'agent-instance-7'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /invalid ROAD_AGENT_ID/);
});

test('launcher generates distinct runtime sessions for concurrent processes of one logical agent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blackroad-launcher-profile-'));
  const stateRoot = join(root, '.road-agents', 'shared', 'messaging');
  t.after(() => rm(root, { recursive: true, force: true }));

  const [first, second] = await Promise.all([
    dynamicSessionRef(stateRoot, 'agent-instance-4'),
    dynamicSessionRef(stateRoot, 'agent-instance-4'),
  ]);

  assert.match(first, /^messaging-mcp:agent-instance-4:/);
  assert.match(second, /^messaging-mcp:agent-instance-4:/);
  assert.notEqual(first, second);
});

test('launcher preserves an explicitly supplied approved session reference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blackroad-launcher-explicit-'));
  const stateRoot = join(root, '.road-agents', 'shared', 'messaging');
  t.after(() => rm(root, { recursive: true, force: true }));

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'messaging_agent_status', arguments: {} },
  });
  const child = spawn('/bin/bash', [LAUNCHER, 'agent-instance-3'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ROAD_WORKSPACE_ROOT: root,
      ROAD_MESSAGING_STATE_ROOT: stateRoot,
      ROAD_SESSION_REF: 'approved-session-ref-3',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stdin.write(`${request}\n`);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('explicit session response timeout')), 4000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      setTimeout(resolvePromise, 40);
    });
  });
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => child.once('close', resolvePromise));
  const response = JSON.parse(Buffer.concat(chunks).toString('utf8').trim().split('\n')[0]);
  assert.equal(response.result.structuredContent.actor.sessionRef, 'approved-session-ref-3');
});

test('installer and launcher are present as shell-readable files', async () => {
  const launcherMode = (await stat(LAUNCHER)).mode & 0o777;
  const installerMode = (await stat(join(ROOT, 'install-workspace.sh'))).mode & 0o777;
  assert.ok(launcherMode >= 0);
  assert.ok(installerMode >= 0);
  assert.match(await readFile(LAUNCHER, 'utf8'), /ROAD_SESSION_REF/);
  assert.match(await readFile(join(ROOT, 'install-workspace.sh'), 'utf8'), /global config: unchanged/);
});
