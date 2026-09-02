import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { MessagingError, operationCapability, planMirror, planOperation, providerSnapshot } from './framework.mjs';
import { planMentionedMessage } from './mentions.mjs';
import { publicOutboxStatus } from './outbox.mjs';
import { pipelinePublicStatus } from './pipeline.mjs';
import { closeSubscription, inboxForAgent, publicRouterStatus, registerSubscription, transitionInboxItem } from './router.mjs';
import { finishRoadCollabHandoff, prepareRoadCollabHandoff, roadCollabDrainPlan } from './road-collab-adapter.mjs';
import { initializeMessagingStore, readPipelineState, resolveMessagingStateRoot, withMessagingTransaction } from './store.mjs';

const AGENT_PATTERN = /^(connector-orchestrator|agent-instance-[1-6])$/;
const BROKER_AGENTS = new Set(['connector-orchestrator', 'agent-instance-4']);

export const AGENT_MCP_TOOLS = [
  ['messaging_agent_status', 'Read aggregate messaging, router, and handoff-outbox status'],
  ['messaging_agent_inbox', 'Read the authenticated agent session inbox'],
  ['messaging_agent_subscribe', 'Register a bounded provider/thread/mention subscription for the authenticated agent session'],
  ['messaging_agent_subscription_close', 'Close a subscription owned by the authenticated agent session'],
  ['messaging_agent_inbox_transition', 'Transition one inbox item owned by the authenticated agent session'],
  ['messaging_agent_provider_capabilities', 'Read reviewed operations and connection state for one messaging provider'],
  ['messaging_agent_operation_plan', 'Plan a provider-native messaging operation using authenticated agent/session identity'],
  ['messaging_agent_mirror_plan', 'Plan a one-way verified cross-provider projection'],
  ['messaging_agent_mention_plan', 'Map canonical Road identities into explicit provider mention formats'],
  ['messaging_agent_outbox_drain_plan', 'List reference-safe pending collaboration handoffs for an authorized broker'],
  ['messaging_agent_outbox_prepare', 'Claim one messaging outbox item and prepare its road-collab handoff command'],
  ['messaging_agent_outbox_finish', 'Record verified, failed, cancelled, or unknown road-collab handoff delivery'],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: true },
}));

function identityFromEnv(env) {
  const agentId = String(env.ROAD_AGENT_ID || '');
  const sessionRef = String(env.ROAD_SESSION_REF || '');
  if (!AGENT_PATTERN.test(agentId)) {
    throw new MessagingError('MCP_AGENT_ID_REQUIRED', 'ROAD_AGENT_ID must be connector-orchestrator or agent-instance-1 through agent-instance-6');
  }
  if (!sessionRef) throw new MessagingError('MCP_SESSION_REF_REQUIRED', 'ROAD_SESSION_REF must identify the exact running MCP session');
  return { agentId, sessionRef };
}

function safePrivateInboxItem(item) {
  return {
    id: item.id,
    deliveryId: item.deliveryId,
    agentId: item.agentId,
    sessionRef: item.sessionRef,
    messageId: item.messageId,
    threadResource: item.threadResource,
    providerId: item.providerId,
    providerMessageRef: item.providerMessageRef,
    sourceReceiptRef: item.sourceReceiptRef,
    kind: item.kind,
    priority: item.priority,
    state: item.state,
    mentionRefs: item.mentionRefs,
    attachmentRefs: item.attachmentRefs,
    bodyRef: item.bodyRef,
    bodyHash: item.bodyHash,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    resultRef: item.resultRef || null,
    rawBodyPersisted: false,
    bodyPersisted: false,
  };
}

function structured(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export async function callAgentMessagingTool(name, args = {}, context = {}) {
  const env = context.env || process.env;
  const identity = identityFromEnv(env);
  const stateRoot = resolveMessagingStateRoot({ stateRoot: context.stateRoot, env });
  await initializeMessagingStore(stateRoot);

  if (name === 'messaging_agent_status') {
    const state = await readPipelineState(stateRoot);
    return structured({
      service: 'road://service/messaging',
      actor: identity,
      messaging: pipelinePublicStatus(state),
      router: publicRouterStatus(state.router),
      outbox: publicOutboxStatus(state),
    });
  }

  if (name === 'messaging_agent_inbox') {
    const state = await readPipelineState(stateRoot);
    const items = inboxForAgent(state.router, identity.agentId, { states: args.states });
    return structured({
      agentId: identity.agentId,
      sessionRef: identity.sessionRef,
      items: items.filter((item) => item.sessionRef === identity.sessionRef).map(safePrivateInboxItem),
    });
  }

  if (name === 'messaging_agent_subscribe') {
    const result = await withMessagingTransaction(stateRoot, async (state) => {
      const registered = registerSubscription(state.router, {
        agentId: identity.agentId,
        sessionRef: identity.sessionRef,
        providerIds: args.providerIds || [],
        threadResources: args.threadResources || [],
        mentionRefs: args.mentionRefs || [],
        kinds: args.kinds || [],
        actionRequiredOnly: Boolean(args.actionRequiredOnly),
        deliveryMode: args.deliveryMode || 'INBOX',
      });
      state.router = registered.state;
      return { state, subscription: registered.subscription, replay: registered.replay };
    }, identity);
    return structured({ subscription: result.subscription, replay: result.replay });
  }

  if (name === 'messaging_agent_subscription_close') {
    const result = await withMessagingTransaction(stateRoot, async (state) => {
      const closed = closeSubscription(state.router, {
        agentId: identity.agentId,
        sessionRef: identity.sessionRef,
        subscriptionId: args.subscriptionId,
      });
      state.router = closed.state;
      return { state, subscription: closed.subscription, replay: closed.replay };
    }, identity);
    return structured({ subscription: result.subscription, replay: result.replay });
  }

  if (name === 'messaging_agent_inbox_transition') {
    const result = await withMessagingTransaction(stateRoot, async (state) => {
      const transitioned = transitionInboxItem(state.router, {
        agentId: identity.agentId,
        sessionRef: identity.sessionRef,
        inboxItemId: args.inboxItemId,
        state: args.state,
        resultRef: args.resultRef || null,
      });
      state.router = transitioned.state;
      return {
        state,
        item: transitioned.item,
        authorityGranted: transitioned.authorityGranted,
        satisfiesUserApproval: transitioned.satisfiesUserApproval,
        satisfiesGovernance: transitioned.satisfiesGovernance,
      };
    }, identity);
    return structured({
      item: safePrivateInboxItem(result.item),
      authorityGranted: result.authorityGranted,
      satisfiesUserApproval: result.satisfiesUserApproval,
      satisfiesGovernance: result.satisfiesGovernance,
    });
  }

  if (name === 'messaging_agent_provider_capabilities') {
    if (args.operation) return structured(operationCapability(args.providerId, args.operation));
    const provider = providerSnapshot().find((item) => item.id === String(args.providerId || '').toLowerCase());
    if (!provider) throw new MessagingError('UNKNOWN_PROVIDER', `Unknown messaging provider ${args.providerId || '<missing>'}`);
    return structured(provider);
  }

  if (name === 'messaging_agent_operation_plan') {
    return structured(planOperation({
      ...args,
      agentId: identity.agentId,
      sessionRef: identity.sessionRef,
      targetOwnerAgent: args.targetOwnerAgent || identity.agentId,
    }));
  }

  if (name === 'messaging_agent_mirror_plan') return structured(planMirror(args));
  if (name === 'messaging_agent_mention_plan') return structured(planMentionedMessage(args));

  if (name === 'messaging_agent_outbox_drain_plan') {
    if (!BROKER_AGENTS.has(identity.agentId)) throw new MessagingError('OUTBOX_BROKER_REQUIRED', 'This agent cannot drain messaging handoffs');
    const state = await readPipelineState(stateRoot);
    return structured({ actor: identity, items: roadCollabDrainPlan(state, { limit: args.limit }) });
  }

  if (name === 'messaging_agent_outbox_prepare') {
    if (!BROKER_AGENTS.has(identity.agentId)) throw new MessagingError('OUTBOX_BROKER_REQUIRED', 'This agent cannot prepare messaging handoff delivery');
    const result = await withMessagingTransaction(stateRoot, async (state) => {
      const prepared = prepareRoadCollabHandoff(state, {
        outboxId: args.outboxId,
        agentId: identity.agentId,
        sessionRef: identity.sessionRef,
        ttlSeconds: args.ttlSeconds,
      });
      return { ...prepared, state: prepared.state };
    }, identity);
    return structured({
      outboxItemId: result.outboxItem.id,
      replay: result.replay,
      mayCallBroker: result.mayCallBroker,
      broker: result.broker,
    });
  }

  if (name === 'messaging_agent_outbox_finish') {
    if (!BROKER_AGENTS.has(identity.agentId)) throw new MessagingError('OUTBOX_BROKER_REQUIRED', 'This agent cannot finish messaging handoff delivery');
    const result = await withMessagingTransaction(stateRoot, async (state) => {
      const finished = finishRoadCollabHandoff(state, {
        ...args,
        agentId: identity.agentId,
        sessionRef: identity.sessionRef,
      });
      return { ...finished, state: finished.state };
    }, identity);
    return structured({
      itemId: result.item.id,
      state: result.item.state,
      releaseClaim: result.releaseClaim,
      retryAllowed: result.retryAllowed,
      next: result.next || null,
    });
  }

  throw new MessagingError('MCP_TOOL_UNKNOWN', `Unknown messaging agent tool ${name}`);
}

function makeResponse(id, payload) {
  return { jsonrpc: '2.0', id, ...payload };
}

async function handleRequest(request, context = {}) {
  if (request.method === 'initialize') {
    return makeResponse(request.id, {
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'blackroad-agent-messaging', version: '1.2.0' },
      },
    });
  }
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'tools/list') return makeResponse(request.id, { result: { tools: AGENT_MCP_TOOLS } });
  if (request.method === 'tools/call') {
    try {
      const result = await callAgentMessagingTool(request.params?.name, request.params?.arguments || {}, context);
      return makeResponse(request.id, { result });
    } catch (error) {
      return makeResponse(request.id, {
        error: {
          code: -32000,
          message: error.message,
          data: { name: error.name, code: error.code || null },
        },
      });
    }
  }
  return makeResponse(request.id, { error: { code: -32601, message: `Method not found: ${request.method}` } });
}

class InputFramer {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.mode = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  drain() {
    while (this.buffer.length) {
      if (!this.mode) {
        this.mode = this.buffer.toString('utf8', 0, Math.min(this.buffer.length, 32)).startsWith('Content-Length:')
          ? 'content-length'
          : 'newline';
      }
      if (this.mode === 'newline') {
        const index = this.buffer.indexOf(0x0a);
        if (index < 0) return;
        const line = this.buffer.subarray(0, index).toString('utf8').trim();
        this.buffer = this.buffer.subarray(index + 1);
        if (line) this.onMessage(line, 'newline');
        continue;
      }
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = headerText.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) throw new MessagingError('MCP_FRAME_INVALID', 'Content-Length frame is missing a valid length');
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.onMessage(body, 'content-length');
      this.mode = null;
    }
  }
}

function writeResponse(value, framing) {
  const text = JSON.stringify(value);
  if (framing === 'content-length') {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

export function startAgentMessagingMcp(context = {}) {
  const framer = new InputFramer((body, framing) => {
    Promise.resolve()
      .then(() => handleRequest(JSON.parse(body), context))
      .then((response) => {
        if (response) writeResponse(response, framing);
      })
      .catch((error) => {
        writeResponse(makeResponse(null, {
          error: { code: -32700, message: error.message, data: { code: error.code || null } },
        }), framing);
      });
  });
  process.stdin.on('data', (chunk) => framer.push(chunk));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) startAgentMessagingMcp();
