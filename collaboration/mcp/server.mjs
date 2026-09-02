#!/usr/bin/env node
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStateStore } from "./lib/store.mjs";
import { CollaborationBroker } from "./lib/broker.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentId = process.env.ROAD_AGENT_ID;
const sessionRef = process.env.ROAD_SESSION_REF;
const statePath = process.env.ROAD_COLLAB_MCP_STATE ?? resolve(process.cwd(), ".road-agents/shared/collaboration/mcp-state.json");
const templatesPath = process.env.ROAD_COLLAB_TEMPLATES ?? resolve(here, "../workflow-templates.json");
const ndjson = process.env.ROAD_MCP_NDJSON === "1";

if (!agentId || !sessionRef) {
  process.stderr.write("ROAD_AGENT_ID and ROAD_SESSION_REF are required\n");
  process.exit(64);
}

const broker = new CollaborationBroker({
  store: new JsonStateStore({ statePath }),
  templatesPath
});

const tools = [
  [
    "road_collab_session_heartbeat",
    "Register or refresh this exact agent runtime session.",
    {
      type: "object",
      properties: { runtime: { type: "string" }, provider: { type: "string" } },
      additionalProperties: false
    }
  ],
  [
    "road_collab_status",
    "Read collaboration state counts and current generation.",
    { type: "object", properties: {}, additionalProperties: false }
  ],
  [
    "road_collab_workflow_templates",
    "List causal cross-connector workflow templates.",
    { type: "object", properties: {}, additionalProperties: false }
  ],
  [
    "road_collab_workflow_instantiate",
    "Instantiate a workflow template into durable agent-owned work items.",
    {
      type: "object",
      required: ["templateId", "idempotencyKey"],
      properties: {
        templateId: { type: "string" },
        workflowId: { type: "string" },
        idempotencyKey: { type: "string" },
        parameters: { type: "object" },
        connectorBindings: { type: "object" },
        delegationContractRef: { type: ["string", "null"] }
      },
      additionalProperties: false
    }
  ],
  [
    "road_collab_queue_list",
    "List this agent's ready and blocked work without exposing another actor's queue.",
    {
      type: "object",
      properties: { includeTerminal: { type: "boolean" } },
      additionalProperties: false
    }
  ],
  [
    "road_collab_work_item_start",
    "Claim and start one ready work item for this exact runtime session.",
    {
      type: "object",
      required: ["workItemId"],
      properties: {
        workItemId: { type: "string" },
        expectedResourceVersionRef: { type: ["string", "null"] }
      },
      additionalProperties: false
    }
  ],
  [
    "road_collab_work_item_finish",
    "Finish an owned work item; successful mutation requires verified read-back evidence.",
    {
      type: "object",
      required: ["workItemId", "outcome"],
      properties: {
        workItemId: { type: "string" },
        outcome: { enum: ["SUCCEEDED", "FAILED", "TIMEOUT_UNKNOWN", "CANCELLED"] },
        resultRef: { type: ["string", "null"] },
        verificationRef: { type: ["string", "null"] },
        observedResourceVersionRef: { type: ["string", "null"] }
      },
      additionalProperties: false
    }
  ],
  [
    "road_collab_delegation_create",
    "Offer an owned non-running work item to another BlackRoad agent under an explicit contract.",
    {
      type: "object",
      required: ["workItemId", "toAgentId", "contractRef", "idempotencyKey"],
      properties: {
        workItemId: { type: "string" },
        toAgentId: { type: "string" },
        contractRef: { type: "string" },
        acceptanceRefs: { type: "array", items: { type: "string" } },
        idempotencyKey: { type: "string" }
      },
      additionalProperties: false
    }
  ],
  [
    "road_collab_delegation_resolve",
    "Accept or reject a delegation addressed to this exact agent session.",
    {
      type: "object",
      required: ["delegationId", "decision"],
      properties: {
        delegationId: { type: "string" },
        decision: { enum: ["ACCEPTED", "REJECTED"] },
        resultRef: { type: ["string", "null"] }
      },
      additionalProperties: false
    }
  ],
  [
    "road_collab_notifications_list",
    "List durable notifications addressed to this agent.",
    {
      type: "object",
      properties: { includeAcknowledged: { type: "boolean" } },
      additionalProperties: false
    }
  ],
  [
    "road_collab_notification_ack",
    "Acknowledge one notification from this exact runtime session.",
    {
      type: "object",
      required: ["notificationId"],
      properties: { notificationId: { type: "string" } },
      additionalProperties: false
    }
  ]
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function writeMessage(message) {
  const body = JSON.stringify(message);
  if (ndjson) process.stdout.write(`${body}\n`);
  else process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

async function callTool(name, args = {}) {
  const bound = { agentId, sessionRef };
  switch (name) {
    case "road_collab_session_heartbeat":
      return broker.heartbeat({ ...bound, runtime: args.runtime, provider: args.provider });
    case "road_collab_status":
      return broker.status();
    case "road_collab_workflow_templates":
      return broker.templates();
    case "road_collab_workflow_instantiate":
      return broker.instantiateWorkflow({ ...bound, ...args });
    case "road_collab_queue_list":
      return broker.queue({ ...bound, ...args });
    case "road_collab_work_item_start":
      return broker.startWorkItem({ ...bound, ...args });
    case "road_collab_work_item_finish":
      return broker.finishWorkItem({ ...bound, ...args });
    case "road_collab_delegation_create":
      return broker.createDelegation({ ...bound, ...args });
    case "road_collab_delegation_resolve":
      return broker.resolveDelegation({ ...bound, ...args });
    case "road_collab_notifications_list":
      return broker.notifications({ ...bound, ...args });
    case "road_collab_notification_ack":
      return broker.acknowledgeNotification({ ...bound, ...args });
    default:
      throw new Error(`unknown-tool:${name}`);
  }
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") throw new Error("invalid-json-rpc");
  if (message.method === "notifications/initialized") return;

  if (message.method === "initialize") {
    return writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "blackroad-collaboration", version: "0.10.0" }
      }
    });
  }

  if (message.method === "ping") {
    return writeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
  }

  if (message.method === "tools/list") {
    return writeMessage({ jsonrpc: "2.0", id: message.id, result: { tools } });
  }

  if (message.method === "tools/call") {
    try {
      const value = await callTool(message.params?.name, message.params?.arguments ?? {});
      return writeMessage({ jsonrpc: "2.0", id: message.id, result: toolResult(value) });
    } catch (error) {
      return writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: String(error?.message ?? error) }],
          isError: true
        }
      });
    }
  }

  if (message.id != null) {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" }
    });
  }
}

let chain = Promise.resolve();
const enqueue = (message) => {
  chain = chain
    .then(() => handle(message), () => handle(message))
    .catch((error) => {
      if (message?.id != null) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: String(error?.message ?? error) }
        });
      }
    });
};

if (ndjson) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      enqueue(JSON.parse(line));
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: String(error?.message ?? error) }
      });
    }
  });
} else {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const header = buffer.subarray(0, boundary).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(boundary + 4);
        continue;
      }
      const length = Number(match[1]);
      if (buffer.length < boundary + 4 + length) break;
      const body = buffer.subarray(boundary + 4, boundary + 4 + length).toString("utf8");
      buffer = buffer.subarray(boundary + 4 + length);
      try {
        enqueue(JSON.parse(body));
      } catch (error) {
        writeMessage({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: String(error?.message ?? error) }
        });
      }
    }
  });
}
