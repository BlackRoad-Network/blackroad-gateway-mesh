import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer, route } from './server.mjs';

test('gateway serves its existing routes without Netlify', async (t) => {
  const server = createLocalServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/gateway`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roadUri, 'road://gateway');
  for (const path of ['/gateway/services', '/gateway/health', '/gateway/capabilities',
                      '/gateway/messaging', '/gateway/messaging/platforms',
                      '/gateway/messaging/operations', '/gateway/messaging/policy',
                      '/gateway/messaging/surfaces', '/']) {
    const result = await fetch(`${base}${path}`);
    assert.equal(result.status, 200, path);
    await result.text();
    const head = await fetch(`${base}${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), '');
  }
  for (const path of ['/gateway', '/gateway/messaging', '/']) {
    const result = await fetch(`${base}${path}`, { method: 'POST', body: 'ignored' });
    assert.equal(result.status, 405);
    assert.equal((await result.json()).error, 'method_not_allowed');
  }
  const options = await fetch(`${base}/gateway`, { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  for (const path of ['/missing', '/package.json', '/.git/config',
                      '/gateway/services/missing', '/gateway/messaging/platforms/missing']) {
    const result = await fetch(`${base}${path}`);
    assert.equal(result.status, 404, path);
    await result.text();
  }
  const malformed = await fetch(`${base}/gateway/services/%ZZ`);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'bad_request');
});

test('local and edge environment adapters preserve status and endpoint semantics', async () => {
  const key = 'ROAD_GATEWAY_GITHUB_STATUS';
  const endpoint = 'ROAD_GATEWAY_GITHUB';
  const oldStatus = process.env[key], oldEndpoint = process.env[endpoint];
  const oldNetlify = globalThis.Netlify;
  try {
    process.env[key] = 'CONNECTED';
    process.env[endpoint] = 'http://127.0.0.1:3000';
    let response = await route(new Request('http://local/gateway/services/github'));
    let service = await response.json();
    assert.equal(service.status, 'READY');
    assert.equal(service.endpoint, 'http://127.0.0.1:3000');
    globalThis.Netlify = { env: { get: (name) => name === key ? 'AUTH_FAILED' : undefined } };
    response = await route(new Request('http://local/gateway/services/github'));
    assert.equal((await response.json()).status, 'AUTH_FAILED');
    delete globalThis.Netlify;
    delete process.env[key];
    response = await route(new Request('http://local/gateway/services/github'));
    assert.equal((await response.json()).status, 'UNKNOWN');
  } finally {
    if (oldStatus === undefined) delete process.env[key]; else process.env[key] = oldStatus;
    if (oldEndpoint === undefined) delete process.env[endpoint]; else process.env[endpoint] = oldEndpoint;
    if (oldNetlify === undefined) delete globalThis.Netlify; else globalThis.Netlify = oldNetlify;
  }
});
