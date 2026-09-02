import net from "node:net";
import { mkdir, rm, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonRpcHandler } from "./daemon.mjs";
import { defaultSocketPath } from "./client.mjs";
import { CollaborationFabric } from "./fabric.mjs";

function terminalResult(normalizedStatus) {
  if (["STEP_SUCCEEDED", "EMPTY_OBSERVATION"].includes(normalizedStatus)) return "succeeded";
  if (normalizedStatus === "CANCELLED") return "cancelled";
  if (["STEP_FAILED", "AUTH_REJECTED_NOT_ABSENT"].includes(normalizedStatus)) return "failed";
  return null;
}

export function createFabricJsonRpcHandler(options = {}) {
  const base = createJsonRpcHandler(options);
  const fabric = options.fabric ?? new CollaborationFabric({ stateRoot: options.stateRoot });

  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return base(message);
    const id = message.id ?? null;
    try {
      if (message.method === "connector.result.submit") {
        const receipt = await fabric.submitConnectorResult(message.params ?? {});
        let claimCompletion = null;
        const result = terminalResult(receipt.normalizedStatus);
        if (receipt.claimRef && receipt.claimMayClose && result && message.params?.autoCompleteClaim !== false) {
          const response = await base({
            jsonrpc: "2.0",
            id: `${id}:claim-complete`,
            method: "claim.complete",
            params: {
              session: receipt.sessionId,
              claim: receipt.claimRef,
              result,
              evidence: receipt.eventHash
            }
          });
          if (response?.error) {
            claimCompletion = {
              state: "COMPLETION_FAILED",
              error: response.error,
              claimRemainsAuthoritativeUntilLeaseExpiry: true
            };
          } else {
            claimCompletion = { state: "COMPLETED", result: response?.result ?? null };
          }
        } else if (receipt.claimRef && !receipt.claimMayClose) {
          claimCompletion = {
            state: "HELD_FOR_RECONCILIATION",
            reason: receipt.normalizedStatus,
            blindRetryForbidden: true
          };
        }
        return { jsonrpc: "2.0", id, result: { receipt, claimCompletion } };
      }
      if (message.method === "session.heartbeat.persist") {
        return { jsonrpc: "2.0", id, result: await fabric.heartbeat(message.params ?? {}) };
      }
      if (message.method === "session.stale.list") {
        return { jsonrpc: "2.0", id, result: await fabric.listStaleSessions(message.params ?? {}) };
      }
      if (message.method === "workflow.checkpoint") {
        return { jsonrpc: "2.0", id, result: await fabric.checkpointWorkflow(message.params ?? {}) };
      }
      if (message.method === "workflow.status") {
        return { jsonrpc: "2.0", id, result: await fabric.workflowStatus(message.params?.workflowId) };
      }
      if (message.method === "fabric.verify") {
        return { jsonrpc: "2.0", id, result: await fabric.verify() };
      }
      return base(message);
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error.message,
          data: { code: error.code ?? "INTERNAL_ERROR" }
        }
      };
    }
  };
}

export async function createFabricDaemon(options = {}) {
  const socketPath = options.socketPath ?? defaultSocketPath();
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const handle = createFabricJsonRpcHandler({ ...options, socketPath });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          continue;
        }
        socket.write(`${JSON.stringify(await handle(request))}\n`);
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

export async function runFabricDaemon(options = {}) {
  const daemon = await createFabricDaemon(options);
  process.stdout.write(`${JSON.stringify({
    event: "road.collaboration.fabric.ready",
    socketPath: daemon.socketPath,
    pid: process.pid,
    durableResults: true,
    durableHeartbeats: true
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
  await runFabricDaemon();
}
