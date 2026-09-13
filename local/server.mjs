// Local host for the same Fetch handlers used by the optional Netlify adapter.
// Node's built-in TypeScript stripping is the only loader; no build or npm install.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import gateway from '../netlify/edge-functions/gateway.ts';
import messaging from '../netlify/edge-functions/messaging.ts';

const landing = new URL('../index.html', import.meta.url);

export async function route(request) {
  const path = new URL(request.url).pathname;
  if (path === '/gateway/messaging' || path.startsWith('/gateway/messaging/')) {
    return messaging(request);
  }
  if (path === '/gateway' || path.startsWith('/gateway/')) {
    return gateway(request);
  }
  if (path === '/' || path === '/index.html') {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }
    return new Response(request.method === 'HEAD' ? null : await readFile(landing), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export function createLocalServer() {
  return createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (incoming, outgoing) => {
    // This host has read-only routes. Drain unsupported request bodies, never forward them.
    incoming.resume();
    try {
      const target = incoming.url ?? '/';
      if (!target.startsWith('/') || target.startsWith('//')) {
        throw new URIError('invalid request target');
      }
      const request = new Request(`http://127.0.0.1${target}`, { method: incoming.method });
      const response = await route(request);
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      if (incoming.method === 'HEAD') {
        outgoing.end();
      } else {
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const badRequest = error instanceof URIError || error instanceof TypeError;
      outgoing.writeHead(badRequest ? 400 : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : JSON.stringify({ error: badRequest ? 'bad_request' : 'internal_error' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.env.ROAD_GATEWAY_PORT ?? '1729';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ROAD_GATEWAY_PORT must be an integer from 1 to 65535');
  }
  const server = createLocalServer();
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`BlackRoad Gateway http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
}
