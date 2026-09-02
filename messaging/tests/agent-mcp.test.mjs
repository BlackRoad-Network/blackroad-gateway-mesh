import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MCP_TOOLS, callAgentMessagingTool } from '../agent-mcp-server.mjs';
import { createEmptyMessagingPipelineState } from '../pipeline.mjs';
import { enqueueHandoffPlans } from '../outbox.mjs';
import { registerSubscription, routeMessage } from '../router.mjs';
import { writePipelineState } from '../store.mjs';

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'blackroad-agent-mcp-'));
}

function context(stateRoot, agentId = 'agent-instance-4', sessionRef = 'session-agent4-a') {
  return {
    stateRoot,
    env: {
      ROAD_AGENT_ID: agentId,
      ROAD_SESSION_REF: sessionRef,
      ROAD_MESSAGING_STATE_ROOT: stateRoot,
    },
  };
}

function handoffPlan() {
  return {
    type: 'handoff.create',
    fromAgentId: 'connector-orchestrator',
    toAgentId: 'agent-instance-4',
    connectorId: 'github',
    resourceKey: 'road+message://github/repository/o/r/pr/4',
    summary: 'Review required',
    artifactRefs: ['github:comment:1/content'],
    evidenceRefs: ['github:delivery:1'],
    requestedAction: 'review-and-act',
  };
}

async function seedInbox(root) {
  const state = createEmptyMessagingPipelineState();
  const subscription = registerSubscription(state.router, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['github'],
    deliveryMode: 'INBOX',
  });
  const routed = routeMessage(subscription.state, {
    messageId: 'road://message/github/1',
    threadResource: 'road+message://github/repository/o/r/pr/4',
    providerId: 'github',
    providerMessageRef: 'comment-1',
    kind: 'review',
    actionRequired: true,
    bodyRef: 'github:comment:1/content',
    bodyHash: 'a'.repeat(64),
  });
  state.router = routed.state;
  await writePipelineState(root, state);
  return routed.inboxItems[0];
}

function parseContentLength(buffer) {
  const text = buffer.toString('utf8');
  const headerEnd = text.indexOf('\r\n\r\n');
  assert.ok(headerEnd >= 0);
  const header = text.slice(0, headerEnd);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  assert.ok(match);
  const length = Number(match[1]);
  const body = Buffer.from(text.slice(headerEnd + 4), 'utf8').subarray(0, length).toString('utf8');
  return JSON.parse(body);
}

async function runServerFrame(root, frame, expectedFraming) {
  const serverPath = fileURLToPath(new URL('../agent-mcp-server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ROAD_AGENT_ID: 'agent-instance-4',
      ROAD_SESSION_REF: 'session-agent4-a',
      ROAD_MESSAGING_STATE_ROOT: root,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  const errors = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  child.stdin.write(frame);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('MCP response timeout')), 3000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      setTimeout(resolvePromise, 30);
    });
  });
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => child.once('close', resolvePromise));
  const output = Buffer.concat(chunks);
  assert.equal(Buffer.concat(errors).toString('utf8'), '');
  if (expectedFraming === 'content-length') return parseContentLength(output);
  return JSON.parse(output.toString('utf8').trim().split('\n')[0]);
}

test('agent MCP exposes twelve bounded tools', () => {
  assert.equal(AGENT_MCP_TOOLS.length, 12);
});

test('agent MCP requires stable process identity', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => callAgentMessagingTool('messaging_agent_status', {}, { stateRoot: root, env: {} }),
    (error) => error.code === 'MCP_AGENT_ID_REQUIRED',
  );
});

test('status reports authenticated actor without private targets', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await callAgentMessagingTool('messaging_agent_status', {}, context(root));
  assert.equal(result.structuredContent.actor.agentId, 'agent-instance-4');
  assert.equal(result.structuredContent.actor.sessionRef, 'session-agent4-a');
  assert.equal(Object.hasOwn(result.structuredContent, 'threadResource'), false);
});

test('subscription ignores caller identity override and binds process identity', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await callAgentMessagingTool('messaging_agent_subscribe', {
    agentId: 'agent-instance-2',
    sessionRef: 'stolen-session',
    providerIds: ['slack'],
    deliveryMode: 'INBOX',
  }, context(root));
  assert.equal(result.structuredContent.subscription.agentId, 'agent-instance-4');
  assert.equal(result.structuredContent.subscription.sessionRef, 'session-agent4-a');
});

test('agent inbox returns only items for exact process session', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedInbox(root);
  const own = await callAgentMessagingTool('messaging_agent_inbox', {}, context(root));
  const otherSession = await callAgentMessagingTool('messaging_agent_inbox', {}, context(root, 'agent-instance-4', 'session-agent4-b'));
  assert.equal(own.structuredContent.items.length, 1);
  assert.equal(otherSession.structuredContent.items.length, 0);
});

test('inbox transition uses process identity and grants no authority', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = await seedInbox(root);
  const result = await callAgentMessagingTool('messaging_agent_inbox_transition', {
    inboxItemId: item.id,
    state: 'ACKNOWLEDGED',
  }, context(root));
  assert.equal(result.structuredContent.item.state, 'ACKNOWLEDGED');
  assert.equal(result.structuredContent.authorityGranted, false);
  assert.equal(result.structuredContent.satisfiesUserApproval, false);
  assert.equal(result.structuredContent.satisfiesGovernance, false);
});

test('operation plan injects authenticated agent and session', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await callAgentMessagingTool('messaging_agent_operation_plan', {
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
    body: 'hello',
    idempotencyKey: 'reply-1',
    userApprovalRef: 'approval:current-user-request',
  }, context(root));
  assert.equal(result.structuredContent.state, 'READY');
  assert.equal(result.structuredContent.collaboration.agentId, 'agent-instance-4');
  assert.equal(result.structuredContent.collaboration.sessionRef, 'session-agent4-a');
});

test('non-broker agent cannot drain handoff outbox', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => callAgentMessagingTool('messaging_agent_outbox_drain_plan', {}, context(root, 'agent-instance-2', 'session-2')),
    (error) => error.code === 'OUTBOX_BROKER_REQUIRED',
  );
});

test('broker prepares deterministic road-collab handoff from outbox', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [handoffPlan()]);
  await writePipelineState(root, seeded.state);
  const result = await callAgentMessagingTool('messaging_agent_outbox_prepare', {
    outboxId: seeded.created[0].id,
  }, context(root, 'connector-orchestrator', 'broker-session-a'));
  assert.equal(result.structuredContent.mayCallBroker, true);
  assert.equal(result.structuredContent.broker.command.type, 'handoff.create');
  assert.equal(result.structuredContent.broker.command.toAgentId, 'agent-instance-4');
});

test('broker cannot mark handoff delivered without read-back verification', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const seeded = enqueueHandoffPlans(createEmptyMessagingPipelineState(), [handoffPlan()]);
  await writePipelineState(root, seeded.state);
  await callAgentMessagingTool('messaging_agent_outbox_prepare', {
    outboxId: seeded.created[0].id,
  }, context(root, 'connector-orchestrator', 'broker-session-a'));
  await assert.rejects(
    () => callAgentMessagingTool('messaging_agent_outbox_finish', {
      outboxId: seeded.created[0].id,
      kind: 'success',
      handoffRef: 'road://handoff/1',
    }, context(root, 'connector-orchestrator', 'broker-session-a')),
    (error) => error.code === 'HANDOFF_VERIFICATION_REQUIRED',
  );
});

test('newline-framed MCP initializes successfully', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await runServerFrame(root, `${request}\n`, 'newline');
  assert.equal(response.result.serverInfo.name, 'blackroad-agent-messaging');
});

test('Content-Length-framed MCP lists tools successfully', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const request = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const frame = `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`;
  const response = await runServerFrame(root, frame, 'content-length');
  assert.equal(response.result.tools.length, 12);
});
