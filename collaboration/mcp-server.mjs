import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callCollaboration } from "./client.mjs";

export const MCP_SERVER_NAME = "blackroad-collaboration";
export const MCP_SERVER_VERSION = "1.1.0";
export const DEFAULT_MCP_PROTOCOL_VERSION = process.env.ROAD_MCP_PROTOCOL_VERSION ?? "2025-11-25";
const AGENT_PATTERN = /^agent-instance-[1-6]$/;

const TOOLS = [
  {
    name: "collaboration_register",
    description: "Register the current runtime session under one stable BlackRoad agent identity.",
    inputSchema: { type: "object", properties: { model: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "collaboration_plan",
    description: "Plan one connector operation, including authority gates, ownership, leases, version fencing, and handoffs.",
    inputSchema: {
      type: "object",
      required: ["connector", "target", "operation"],
      properties: {
        connector: { type: "string" },
        target: { type: "string" },
        operation: { type: "string" },
        mode: { enum: ["read", "write", "admin"] },
        idempotencyKey: { type: "string" },
        expectedVersion: { type: "string" },
        decisionReceiptRef: { type: "string" },
        delegationRef: { type: "string" },
        payloadRef: { type: "string" },
        secretRef: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_workflow_plan",
    description: "Plan a multi-connector DAG with parallel-safe waves, inferred serialization, gates, and cross-agent handoffs.",
    inputSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        workflowId: { type: "string" },
        correlationId: { type: "string" },
        steps: { type: "array", minItems: 1, items: { type: "object" } }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_claim",
    description: "Plan and reserve an exclusive connector mutation claim. Read operations return without a claim.",
    inputSchema: {
      type: "object",
      required: ["connector", "target", "operation"],
      properties: {
        connector: { type: "string" },
        target: { type: "string" },
        operation: { type: "string" },
        mode: { enum: ["read", "write", "admin"] },
        idempotencyKey: { type: "string" },
        expectedVersion: { type: "string" },
        decisionReceiptRef: { type: "string" },
        delegationRef: { type: "string" },
        payloadRef: { type: "string" },
        secretRef: { type: "string" },
        ttlSeconds: { type: "integer", minimum: 10, maximum: 3600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_complete",
    description: "Complete a claimed operation and record its outcome and evidence receipt.",
    inputSchema: {
      type: "object",
      required: ["claim", "result"],
      properties: {
        claim: { type: "string" },
        result: { enum: ["succeeded", "failed", "cancelled", "timeout_unknown"] },
        evidence: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_handoff",
    description: "Offer a typed, recipient-bound handoff to another stable BlackRoad agent.",
    inputSchema: {
      type: "object",
      required: ["toAgent", "kind", "summary"],
      properties: {
        toAgent: { type: "string", pattern: "^agent-instance-[1-6]$" },
        kind: { type: "string" },
        summary: { type: "string" },
        evidence: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_ack",
    description: "Acknowledge a handoff as the intended recipient session.",
    inputSchema: {
      type: "object",
      required: ["handoff"],
      properties: { handoff: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_status",
    description: "Read daemon health and collaboration state without mutating providers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "collaboration_reconcile",
    description: "Classify stale claims, unknown timeouts, and incomplete handoffs without retrying provider actions.",
    inputSchema: {
      type: "object",
      properties: {
        operations: { type: "array" },
        claims: { type: "array" },
        handoffs: { type: "array" },
        now: { type: "string" }
      },
      additionalProperties: false
    }
  }
];

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError
  };
}

export function createMcpHandler(options = {}) {
  const agentId = options.agentId ?? process.env.ROAD_AGENT_ID;
  const runtime = options.runtime ?? process.env.ROAD_AGENT_RUNTIME ?? "claude";
  const model = options.model ?? process.env.ROAD_AGENT_MODEL ?? null;
  const call = options.call ?? ((method, params, callOptions) => callCollaboration(method, params, {
    socketPath: options.socketPath,
    ...callOptions
  }));

  if (!AGENT_PATTERN.test(agentId ?? "")) {
    throw Object.assign(new Error("ROAD_AGENT_ID must be agent-instance-1 through agent-instance-6"), {
      code: "INVALID_AGENT_ID"
    });
  }

  let collaborationSession = null;
  const serverSessionId = `mcp_${randomUUID()}`;

  async function register(requestedModel = model) {
    if (collaborationSession) return collaborationSession;
    const result = await call("collaboration.register", {
      agent: agentId,
      runtime,
      ...(requestedModel ? { model: requestedModel } : {})
    });
    collaborationSession = result?.sessionId ?? result?.id ?? result?.session?.id ?? result;
    return collaborationSession;
  }

  async function callTool(name, args = {}) {
    if (name === "collaboration_register") return register(args.model);
    const sessionId = await register();
    if (name === "collaboration_plan") return call("dispatch.plan", { ...args, agentId, sessionId });
    if (name === "collaboration_workflow_plan") return call("workflow.plan", { ...args, agentId, sessionId });
    if (name === "collaboration_claim") return call("dispatch.reserve", { ...args, agentId, sessionId });
    if (name === "collaboration_complete") return call("claim.complete", { ...args, session: sessionId });
    if (name === "collaboration_handoff") return call("handoff.offer", { ...args, fromSession: sessionId });
    if (name === "collaboration_ack") return call("handoff.ack", { ...args, session: sessionId });
    if (name === "collaboration_status") {
      const [ping, state] = await Promise.all([
        call("ping", {}),
        call("state.summary", {})
      ]);
      return { ping, state, agentId, sessionId };
    }
    if (name === "collaboration_reconcile") return call("reconcile", args);
    throw Object.assign(new Error(`unknown_tool:${name}`), { code: "METHOD_NOT_FOUND" });
  }

  return async function handle(message) {
    const id = message.id ?? null;
    try {
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
            instructions: "Use this control plane before connector mutations. Runtime and model provenance never grant authority."
          }
        };
      }
      if (message.method === "notifications/initialized") return null;
      if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      if (message.method === "tools/call") {
        const result = await callTool(message.params?.name, message.params?.arguments ?? {});
        return { jsonrpc: "2.0", id, result: textResult(result) };
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error.message,
          data: { code: error.code ?? "INTERNAL_ERROR", serverSessionId }
        }
      };
    }
  };
}

export async function runStdio(options = {}) {
  const handle = createMcpHandler(options);
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false
  });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      })}\n`);
      continue;
    }
    const response = await handle(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runStdio();
}
