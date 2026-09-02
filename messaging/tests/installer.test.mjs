import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INSTALLER = join(ROOT, 'install-workspace.sh');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('installer defaults to a non-mutating dry run', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'blackroad-messaging-install-dry-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const result = spawnSync('/bin/bash', [INSTALLER, '--workspace', workspace], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /mode:\s+dry-run/);
  assert.match(result.stdout, /No files changed\./);
  assert.match(result.stdout, /global config:\s+unchanged/);
  assert.match(result.stdout, /secrets:\s+not copied/);
  assert.equal(await exists(join(workspace, 'system', 'messaging')), false);
  assert.equal(await exists(join(workspace, '.road-agents', 'shared', 'messaging')), false);
});

test('installer rejects missing workspace argument', () => {
  const result = spawnSync('/bin/bash', [INSTALLER, '--workspace'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /missing value for --workspace/);
});

test('installer rejects unknown options without mutating', () => {
  const result = spawnSync('/bin/bash', [INSTALLER, '--invent-a-cloud'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown option/);
});

test('installer help documents explicit apply and replace semantics', () => {
  const result = spawnSync('/bin/bash', [INSTALLER, '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Default behavior is a dry run/);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--replace/);
  assert.match(result.stdout, /does not edit global Claude configuration/);
});
