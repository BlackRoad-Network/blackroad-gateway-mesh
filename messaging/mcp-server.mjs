import { createInterface } from 'node:readline';
import {
  canonicalThreadResource,
  classifyOutcome,
  operationCapability,
  planMirror,
  planOperation,
  planReceipt,
  providerSnapshot,
  reactionMeaning,
} from './framework.mjs';

export const TOOL_DEFINITIONS = [
  ['messaging_providers', 'List messaging providers and reviewed adapter state'],
  ['messaging_provider_capabilities', 'Resolve operations supported by one provider'],
  ['messaging_thread_normalize', 'Normalize a provider thread into a canonical Road resource'],
  ['messaging_thread_read_plan', 'Plan a read-only thread retrieval'],
  ['messaging_thread_create_plan', 'Plan a new provider discussion or top-level message'],
  ['messaging_reply_plan', 'Plan a provider thread reply'],
  ['messaging_message_edit_plan', 'Plan a provider message or comment edit'],
  ['messaging_message_delete_plan', 'Plan a provider message or comment deletion'],
  ['messaging_reaction_plan', 'Plan a social reaction without treating it as authority'],
  ['messaging_thread_resolution_plan', 'Plan thread resolve or reopen when supported'],
  ['messaging_mirror_plan', 'Plan one-way verified cross-provider projection'],
  ['messaging_outcome_plan', 'Classify provider outcomes without flattening uncertainty'],
  ['messaging_receipt_plan', 'Build a reference-only messaging receipt after verification'],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: 'object', additionalProperties: true },
}));

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function callTool(name, args = {}) {
  if (name === 'messaging_providers') return result(providerSnapshot());
  if (name === 'messaging_provider_capabilities') {
    const provider = providerSnapshot().find((item) => item.id === args.providerId);
    if (!provider) return result(operationCapability(args.providerId, args.operation || 'readThread'));
    return result(provider);
  }
  if (name === 'messaging_thread_normalize') {
    return result({ resourceKey: canonicalThreadResource(args.providerId, args.target || {}) });
  }
  if (name === 'messaging_thread_read_plan') {
    return result(planOperation({ ...args, operation: 'readThread' }));
  }
  if (name === 'messaging_thread_create_plan') {
    return result(planOperation({ ...args, operation: 'createThread' }));
  }
  if (name === 'messaging_reply_plan') {
    return result(planOperation({ ...args, operation: args.reviewReply ? 'reviewReply' : 'reply' }));
  }
  if (name === 'messaging_message_edit_plan') {
    return result(planOperation({ ...args, operation: 'edit' }));
  }
  if (name === 'messaging_message_delete_plan') {
    return result(planOperation({ ...args, operation: 'delete' }));
  }
  if (name === 'messaging_reaction_plan') {
    return result({
      plan: planOperation({ ...args, operation: 'react' }),
      semantics: reactionMeaning(args.emoji),
    });
  }
  if (name === 'messaging_thread_resolution_plan') {
    return result(planOperation({ ...args, operation: args.reopen ? 'reopen' : 'resolve' }));
  }
  if (name === 'messaging_mirror_plan') return result(planMirror(args));
  if (name === 'messaging_outcome_plan') return result(classifyOutcome(args));
  if (name === 'messaging_receipt_plan') return result(planReceipt(args));
  throw new Error(`Unknown tool: ${name}`);
}

function response(id, payload) {
  return JSON.stringify({ jsonrpc: '2.0', id, ...payload });
}

function handle(request) {
  if (request.method === 'initialize') {
    return response(request.id, {
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'blackroad-messaging-fabric', version: '1.0.0' },
      },
    });
  }
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'tools/list') {
    return response(request.id, { result: { tools: TOOL_DEFINITIONS } });
  }
  if (request.method === 'tools/call') {
    try {
      return response(request.id, {
        result: callTool(request.params?.name, request.params?.arguments || {}),
      });
    } catch (error) {
      return response(request.id, {
        error: {
          code: -32000,
          message: error.message,
          data: { name: error.name, code: error.code || null },
        },
      });
    }
  }
  return response(request.id, {
    error: { code: -32601, message: `Method not found: ${request.method}` },
  });
}

function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const output = handle(request);
    if (output) writeLine(output);
  } catch (error) {
    writeLine(response(null, { error: { code: -32700, message: error.message } }));
  }
});
