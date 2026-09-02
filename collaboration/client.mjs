import net from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function defaultSocketPath() {
  return process.env.ROAD_COLLAB_SOCKET ?? join(
    process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `blackroad-${process.getuid?.() ?? "user"}`),
    "road-collab.sock"
  );
}

export function callCollaboration(method, params = {}, options = {}) {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const id = options.id ?? `rpc_${randomUUID()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(Object.assign(new Error(`collaboration_timeout:${method}`), {
        code: "TIMEOUT_UNKNOWN",
        method,
        socketPath
      }));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      fn(value);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.error) {
          finish(reject, Object.assign(new Error(message.error.message), {
            code: message.error.data?.code ?? "RPC_ERROR",
            rpc: message.error
          }));
        } else {
          finish(resolve, message.result);
        }
      } catch (error) {
        finish(reject, Object.assign(error, { code: "INVALID_RPC_RESPONSE" }));
      }
    });

    socket.on("error", (error) => {
      finish(reject, Object.assign(error, {
        code: error.code === "ENOENT" ? "COLLABORATION_DAEMON_UNAVAILABLE" : error.code
      }));
    });

    socket.on("end", () => {
      if (!settled) finish(reject, Object.assign(new Error("collaboration_connection_closed"), {
        code: "CONNECTION_CLOSED"
      }));
    });
  });
}
