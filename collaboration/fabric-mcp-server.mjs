import readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callCollaboration } from "./client.mjs";
import { createMcpHandler } from "./mcp-server.mjs";

const AGENT_RE = /^agent-instance-[1-6]$/;
const EXTRA_TOOLS = [
  {
    name: "collaboration_report_connector_result",
    description: "Persist a provider-native connector result, normalize its state, preserve timeout uncertainty, and close only safely terminal claims.",
    inputSchema: {
      type: "object",
      required: ["connector", "target", "operation", "status"],
      properties: {
        connector: { type: "string" },
        target: { type: "string" },
        operation: { type: "string" },
        status: { type: "string" },
        mode: { enum: ["read", "write", "admin"] },
        claimRef: { type: "string" },
        planId: { type: "string" },
        planHash: { type: "string" },
        workflowId: { type: "string" },
        stepId: { type: "string" },
        resourceKey: { type: "string" },
        idempotencyKey: { type: "string" },
        expectedVersion: { type: "string" },
        providerVersionBefore: { type: "string" },
        providerVersionAfter: { type: "string" },
        count: { type: "integer", minimum: 0 },
        evidenceRefs: { type: "array", items: { type: "string" }, uniqueItems: true },
        correlationId: { type: "string" },
        causationId: { type: "string" },
        secretRefs: { type: "array", items: { type: "string" }, uniqueItems: true },
        autoCompleteClaim: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_heartbeat",
    description: "Persist a liveness observation for the current agent session without extending connector claim authority.",
    inputSchema: {
      type: "object",
      properties: {
        ttlSeconds: { type: "integer", minimum: 10, maximum: 3600 },
        activeClaimRefs: { type: "array", items: { type: "string" }, uniqueItems: true },
        workflowRefs: { type: "array", items: { type: "string" }, uniqueItems: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_stale_sessions",
    description: "List stale session observations. This never force-releases connector claims; their own leases remain authoritative.",
    inputSchema: {
      type: "object",
      properties: { now: { type: "string", format: "date-time" } },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_checkpoint",
    description: "Persist one workflow-step checkpoint with receipt and causal references.",
    inputSchema: {
      type: "object",
      required: ["workflowId", "stepId", "state"],
      properties: {
        workflowId: { type: "string" },
        stepId: { type: "string" },
        state: { type: "string" },
        connector: { type: "string" },
        target: { type: "string" },
        receiptRef: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" }, uniqueItems: true },
        evidenceRefs: { type: "array", items: { type: "string" }, uniqueItems: true },
        correlationId: { type: "string" },
        causationId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_workflow_status",
    description: "Read the latest durable checkpoint for every recorded step in a connector workflow.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: { workflowId: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_verify_fabric",
    description: "Verify the hash chain of connector-result, heartbeat, and workflow-checkpoint journals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false
  };
}

export function createFabricMcpHandler(options = {}) {
  const agentId = options.agentId ?? process.env.ROAD_AGENT_ID;
  const runtime = options.runtime ?? process.env.ROAD_AGENT_RUNTIME ?? "claude";
  const model = options.model ?? process.env.ROAD_AGENT_MODEL ?? null;
  const transportCall = options.call ?? ((method, params, callOptions) => callCollaboration(method, params, {
    socketPath: options.socketPath,
    ...callOptions
  }));

  if (!AGENT_RE.test(agentId ?? "")) {
    throw Object.assign(new Error("ROAD_AGENT_ID must be agent-instance-1 through agent-instance-6"), { code: "INVALID_AGENT_ID" });
  }

  let sessionId = null;
  async function ensureSession() {
    if (sessionId) return sessionId;
    const result = await transportCall("collaboration.register", {
      agent: agentId,
      runtime,
      ...(model ? { model } : {})
    });
    sessionId = result?.sessionId ?? result?.id ?? result?.session?.id ?? result;
    return sessionId;
  }

  const base = createMcpHandler({
    ...options,
    agentId,
    runtime,
    model,
    call: async (method, params, callOptions) => {
      if (method === "collaboration.register") return ensureSession();
      return transportCall(method, params, callOptions);
    }
  });

  async function callExtra(name, args = {}) {
    const session = await ensureSession();
    if (name === "collaboration_report_connector_result") {
      return transportCall("connector.result.submit", { ...args, agentId, sessionId: session });
    }
    if (name === "collaboration_heartbeat") {
      return transportCall("session.heartbeat.persist", { ...args, agentId, sessionId: session, runtime, model });
    }
    if (name === "collaboration_stale_sessions") return transportCall("session.stale.list", args);
    if (name === "collaboration_checkpoint") {
      return transportCall("workflow.checkpoint", { ...args, agentId, sessionId: session });
    }
    if (name === "collaboration_workflow_status") return transportCall("workflow.status", args);
    if (name === "collaboration_verify_fabric") return transportCall("fabric.verify", {});
    return null;
  }

  return async function handle(message) {
    if (message?.method === "tools/list") {
      const response = await base(message);
      response.result.tools.push(...EXTRA_TOOLS);
      return response;
    }
    if (message?.method === "tools/call" && EXTRA_TOOLS.some((tool) => tool.name === message.params?.name)) {
      const id = message.id ?? null;
      try {
        const result = await callExtra(message.params.name, message.params?.arguments ?? {});
        return { jsonrpc: "2.0", id, result: textResult(result) };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error.message, data: { code: error.code ?? "INTERNAL_ERROR" } }
        };
      }
    }
    return base(message);
  };
}

export async function runFabricMcpStdio(options = {}) {
  const handle = createFabricMcpHandler(options);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    const response = await handle(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runFabricMcpStdio();
}
