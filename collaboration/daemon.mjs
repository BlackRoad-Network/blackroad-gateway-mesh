import net from "node:net";
import { mkdir, rm, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { defaultSocketPath } from "./client.mjs";
import { planDispatch, redactPublic } from "./dispatch.mjs";
import { planWorkflow } from "./workflow.mjs";
import { reconcileState } from "./reconcile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cli.mjs");

function parseOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

export function executeCli(command, params = {}, options = {}) {
  const args = [CLI, command];
  const add = (flag, value) => {
    if (value !== undefined && value !== null && value !== "") args.push(flag, String(value));
  };

  if (command === "register") {
    add("--agent", params.agent);
    add("--runtime", params.runtime);
    add("--model", params.model);
  } else if (command === "claim") {
    add("--session", params.session);
    add("--connector", params.connector);
    add("--target", params.target);
    add("--mode", params.mode);
    add("--operation", params.operation);
    add("--idempotency", params.idempotencyKey);
    add("--expected-version", params.expectedVersion);
    add("--ttl", params.ttlSeconds);
  } else if (command === "complete") {
    add("--session", params.session);
    add("--claim", params.claim);
    add("--result", params.result);
    add("--evidence", params.evidence);
  } else if (command === "handoff") {
    add("--from-session", params.fromSession);
    add("--to-agent", params.toAgent);
    add("--kind", params.kind);
    add("--summary", params.summary);
    add("--evidence", params.evidence);
  } else if (command === "ack") {
    add("--session", params.session);
    add("--handoff", params.handoff);
  }

  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...(options.env ?? {}) };
    if (options.stateDir) env.ROAD_COLLAB_STATE = options.stateDir;
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? HERE,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(Object.assign(new Error(stderr.trim() || `road-collab exited ${code}`), {
          code: "COLLAB_CLI_FAILED",
          exitCode: code
        }));
      } else {
        resolvePromise(parseOutput(stdout));
      }
    });
  });
}

export function createJsonRpcHandler(options = {}) {
  const execute = options.execute ?? ((command, params) => executeCli(command, params, options));
  const heartbeats = new Map();
  const methods = {
    ping: async () => ({
      ok: true,
      service: "blackroad-collaboration",
      version: "1.1.0",
      socket: options.socketPath ?? defaultSocketPath(),
      now: new Date().toISOString()
    }),
    "collaboration.register": async (params) => execute("register", {
      agent: params.agent,
      runtime: params.runtime,
      model: params.model
    }),
    "collaboration.heartbeat": async (params) => {
      const beat = {
        sessionId: params.sessionId,
        agentId: params.agentId,
        at: new Date().toISOString(),
        ttlSeconds: params.ttlSeconds ?? 90
      };
      heartbeats.set(params.sessionId, beat);
      return beat;
    },
    "dispatch.plan": async (params) => planDispatch(params, options.dispatchContext),
    "dispatch.reserve": async (params) => {
      const plan = await planDispatch(params, options.dispatchContext);
      if (!plan.canDispatch) return { reserved: false, plan };
      if (!plan.claimRequired) return { reserved: true, plan, claim: null };
      const claim = await execute("claim", {
        session: params.sessionId,
        connector: plan.connector,
        target: plan.target,
        mode: plan.mode,
        operation: plan.operation,
        idempotencyKey: plan.idempotencyKey,
        expectedVersion: plan.expectedVersion,
        ttlSeconds: params.ttlSeconds
      });
      return { reserved: true, plan, claim };
    },
    "claim.acquire": async (params) => execute("claim", params),
    "claim.complete": async (params) => execute("complete", params),
    "handoff.offer": async (params) => execute("handoff", params),
    "handoff.ack": async (params) => execute("ack", params),
    "workflow.plan": async (params) => planWorkflow(params, options.dispatchContext),
    "state.summary": async () => execute("doctor", {}),
    reconcile: async (params) => reconcileState(params)
  };

  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid Request", data: { code: "INVALID_RPC_REQUEST" } }
      };
    }
    const fn = methods[message.method];
    if (!fn) {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32601, message: "Method not found", data: { code: "METHOD_NOT_FOUND" } }
      };
    }
    try {
      const result = await fn(message.params ?? {});
      return { jsonrpc: "2.0", id: message.id ?? null, result: redactPublic(result) };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: {
          code: -32000,
          message: error.message,
          data: { code: error.code ?? "INTERNAL_ERROR" }
        }
      };
    }
  };
}

export async function createDaemon(options = {}) {
  const socketPath = options.socketPath ?? defaultSocketPath();
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const handle = createJsonRpcHandler({ ...options, socketPath });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error", data: { code: "PARSE_ERROR" } }
          })}\n`);
          continue;
        }
        socket.write(`${JSON.stringify(await handle(message))}\n`);
      }
    });
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  await chmod(socketPath, 0o600);

  return {
    server,
    socketPath,
    close: async () => {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(socketPath, { force: true });
    }
  };
}

export async function runDaemon(options = {}) {
  const daemon = await createDaemon(options);
  process.stdout.write(`${JSON.stringify({
    event: "road.collaboration.daemon.ready",
    socketPath: daemon.socketPath,
    pid: process.pid
  })}\n`);
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return daemon;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runDaemon();
}
