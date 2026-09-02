import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MessagingError } from './framework.mjs';
import { normalizeVerifiedWebhook } from './inbound.mjs';
import { publicOutboxStatus } from './outbox.mjs';
import { pipelinePublicStatus } from './pipeline.mjs';
import {
  ingestInboundTransaction,
  initializeMessagingStore,
  readPipelineState,
  resolveMessagingStateRoot,
} from './store.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function jsonResponse(response, status, payload, headers = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function errorStatus(error) {
  if (error.code === 'WEBHOOK_BODY_TOO_LARGE') return 413;
  if (error.code === 'WEBHOOK_METHOD_NOT_ALLOWED') return 405;
  if (error.code === 'WEBHOOK_ROUTE_NOT_FOUND') return 404;
  if (error.code === 'WEBHOOK_REPLAY_WINDOW_EXCEEDED') return 401;
  if (error.code === 'WEBHOOK_SIGNATURE_INVALID') return 401;
  if (error.code === 'WEBHOOK_SIGNATURE_HEADERS_REQUIRED') return 401;
  if (error.code === 'SIGNING_SECRET_REQUIRED') return 503;
  if (error.code === 'WEBHOOK_JSON_INVALID') return 400;
  if (error.code === 'INBOUND_TARGET_INCOMPLETE') return 422;
  return 500;
}

async function readRequestBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new MessagingError('WEBHOOK_BODY_TOO_LARGE', `Webhook body exceeds ${limitBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function defaultSecretResolver(providerId) {
  if (providerId === 'slack') return process.env.ROAD_SLACK_SIGNING_SECRET || null;
  if (providerId === 'github') return process.env.ROAD_GITHUB_WEBHOOK_SECRET || null;
  return null;
}

function requestHeaders(request) {
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

export function createMessagingWebhookServer(options = {}) {
  const host = options.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && options.allowNonLoopback !== true) {
    throw new MessagingError('NON_LOOPBACK_BIND_DENIED', `Messaging webhook server refuses non-loopback bind ${host} without explicit authorization`);
  }
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 1731;
  const bodyLimitBytes = Math.max(1024, Math.min(10 * 1024 * 1024, Number(options.bodyLimitBytes || 1024 * 1024)));
  const stateRoot = resolveMessagingStateRoot({ stateRoot: options.stateRoot, env: options.env || process.env });
  const secretResolver = options.secretResolver || defaultSecretResolver;
  const identityMapResolver = options.identityMapResolver || (() => ({ identities: [] }));

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${host}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        await initializeMessagingStore(stateRoot);
        jsonResponse(response, 200, {
          service: 'road://service/messaging',
          status: 'READY_LOCAL',
          bindScope: 'loopback',
          providerExecution: false,
          publicIngress: false,
          stateRootConfigured: true,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        await initializeMessagingStore(stateRoot);
        const state = await readPipelineState(stateRoot);
        jsonResponse(response, 200, {
          messaging: pipelinePublicStatus(state),
          outbox: publicOutboxStatus(state),
        });
        return;
      }

      const match = url.pathname.match(/^\/webhooks\/(slack|github)$/);
      if (!match) throw new MessagingError('WEBHOOK_ROUTE_NOT_FOUND', `Unknown messaging route ${url.pathname}`);
      if (request.method !== 'POST') throw new MessagingError('WEBHOOK_METHOD_NOT_ALLOWED', 'Webhook routes accept POST only');

      const providerId = match[1];
      const rawBody = await readRequestBody(request, bodyLimitBytes);
      const signingSecret = await secretResolver(providerId, request);
      const headers = requestHeaders(request);
      const event = normalizeVerifiedWebhook({
        providerId,
        rawBody,
        headers,
        signingSecret,
        now: options.now ? options.now() : new Date(),
      });

      await initializeMessagingStore(stateRoot);
      const processed = await ingestInboundTransaction(stateRoot, event, {
        identityMap: await identityMapResolver(providerId, request),
        sourceAgentId: 'connector-orchestrator',
        agentId: 'connector-orchestrator',
        sessionRef: options.sessionRef || 'local-webhook-service',
        now: options.now ? options.now() : new Date(),
      });

      if (event.type === 'HANDSHAKE' && providerId === 'slack') {
        const payload = JSON.parse(rawBody.toString('utf8'));
        jsonResponse(response, 200, { challenge: payload.challenge });
        return;
      }

      jsonResponse(response, 202, {
        accepted: true,
        providerId,
        eventId: event.eventId,
        eventType: event.type,
        replay: processed.replay,
        resultState: processed.result.state,
        inboxDeliveries: processed.inboxItems.length,
        handoffOutboxCreated: processed.outboxCreated?.length || 0,
        verificationRef: event.verification.verificationRef,
        rawBodyPersisted: false,
        bodyPersisted: false,
      });
    } catch (error) {
      const status = errorStatus(error);
      jsonResponse(response, status, {
        accepted: false,
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'Messaging ingress could not process the request' : error.message,
        },
      }, status === 405 ? { allow: 'POST' } : {});
    }
  });

  return {
    server,
    host,
    port,
    stateRoot,
    async start() {
      await initializeMessagingStore(stateRoot);
      await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, host, () => {
          server.off('error', rejectPromise);
          resolvePromise();
        });
      });
      const address = server.address();
      return {
        host,
        port: typeof address === 'object' && address ? address.port : port,
        stateRoot,
      };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const service = createMessagingWebhookServer();
  service.start().then((address) => {
    process.stderr.write(`BlackRoad messaging ingress listening on ${address.host}:${address.port}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
