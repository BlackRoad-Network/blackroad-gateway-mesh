import { createServer } from "node:http";
import { createSlackRequestIntake } from "./slack-request-intake.mjs";
import { SlackReferenceInbox } from "./slack-reference-inbox.mjs";

// Returns an unbound Node HTTP server. The host must explicitly listen on
// loopback and configure authenticated TLS ingress separately.
export function createSlackIngressServer({ signingSecret, applicationId, inbox, clock = Date.now, maxBodyBytes = 65_536, requestTimeoutMs = 2_500 } = {}) {
  if (!(inbox instanceof SlackReferenceInbox)) throw new TypeError("a SlackReferenceInbox is required");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_500) throw new RangeError("requestTimeoutMs must be 1..2500");
  const intake = createSlackRequestIntake({ signingSecret, applicationId, clock, maxBodyBytes });
  const server = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    let finished = false;
    let timer;
    let chunks = [];
    let length = 0;
    const reply = (status, body) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chunks = [];
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Connection": "close" });
      response.end(body);
      request.resume();
    };
    response.on("close", () => { finished = true; clearTimeout(timer); chunks = []; });
    request.on("error", () => reply(400, "request rejected"));
    request.on("aborted", () => { finished = true; clearTimeout(timer); chunks = []; });
    if (request.url !== "/slack/events") return reply(404, "not found");
    if (request.method !== "POST") return reply(405, "method not allowed");

    // Node may combine repeated headers. Reject duplicates from rawHeaders so
    // intermediaries cannot choose a different signing or framing value.
    const seen = new Set();
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index].toLowerCase();
      if (!["x-slack-signature", "x-slack-request-timestamp", "content-type", "content-length", "transfer-encoding"].includes(name)) continue;
      if (seen.has(name)) return reply(400, "request rejected");
      seen.add(name);
    }
    if (request.headers["content-length"] !== undefined && Number(request.headers["content-length"]) > maxBodyBytes) return reply(413, "request too large");
    if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") return reply(415, "request rejected");
    let receiving = true;
    timer = setTimeout(() => reply(receiving ? 408 : 503, "request incomplete"), requestTimeoutMs);
    request.on("data", (chunk) => {
      if (finished) return;
      length += chunk.length;
      if (length > maxBodyBytes) return reply(413, "request too large");
      chunks.push(chunk);
    });
    request.on("end", async () => {
      if (finished) return;
      receiving = false;
      try {
        const outcome = intake.handle({ method: request.method, headers: request.headers, rawBody: Buffer.concat(chunks, length) });
        chunks = [];
        if (outcome.event) await inbox.append(outcome.event);
        // No approval is supplied and no dispatcher is called by this server.
        // Only references are durable; no command target enters the inbox.
        reply(outcome.acknowledgement.status, outcome.acknowledgement.body);
      } catch {
        reply(503, "intake unavailable");
      }
    });
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = 1_000;
  return server;
}
