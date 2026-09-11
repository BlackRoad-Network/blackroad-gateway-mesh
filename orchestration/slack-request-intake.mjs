import { createHmac, timingSafeEqual } from "node:crypto";
import { COCKPIT, normalizeSlackEvent, planSlackCommandIntake } from "./slack-control-plane.mjs";

// Host-injected configuration only. Importing this module reads no credentials,
// starts no listener, and performs no provider calls.
export function createSlackRequestIntake({ signingSecret, applicationId, clock = Date.now, maxBodyBytes = 65_536 } = {}) {
  if (typeof signingSecret !== "string" || !signingSecret.trim()) throw new TypeError("signingSecret is required");
  if (typeof applicationId !== "string" || !/^A[A-Z0-9]+$/.test(applicationId) || /\s/.test(applicationId)) throw new TypeError("applicationId must be a Slack app ID");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_048_576) throw new RangeError("maxBodyBytes must be 1..1048576");

  return Object.freeze({
    handle(request, cockpitState = {}) {
      if (request?.method !== "POST") return reject(405, "BLOCKED_METHOD");
      if (!(request.rawBody instanceof Uint8Array)) return reject(400, "BLOCKED_RAW_BODY_REQUIRED");
      if (request.rawBody.byteLength > maxBodyBytes) return reject(413, "BLOCKED_BODY_TOO_LARGE");
      const body = Buffer.from(request.rawBody);
      const signature = header(request.headers, "x-slack-signature");
      const timestamp = header(request.headers, "x-slack-request-timestamp");
      if (typeof signature !== "string" || signature.length !== 67 || !/^v0=[a-f0-9]{64}$/.test(signature) ||
          typeof timestamp !== "string" || timestamp.length > 12 || !/^[1-9][0-9]*$/.test(timestamp) || /[^0-9]/.test(timestamp)) {
        return reject(401, "BLOCKED_REQUEST_SIGNATURE");
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) return reject(503, "BLOCKED_CLOCK");
      if (Math.abs(Math.floor(now / 1_000) - Number(timestamp)) > 300) return reject(401, "BLOCKED_REQUEST_AGE");
      const expected = createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"))) return reject(401, "BLOCKED_REQUEST_SIGNATURE");

      const contentType = header(request.headers, "content-type");
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) {
        return reject(415, "BLOCKED_CONTENT_TYPE");
      }
      let payload;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return reject(400, "BLOCKED_INVALID_JSON");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return reject(400, "BLOCKED_INVALID_ENVELOPE");

      // Slack's URL challenge need not contain team_id/api_app_id. The app's
      // signing secret authenticates it; a challenge never becomes a command.
      if (payload.type === "url_verification") {
        if ((payload.api_app_id !== undefined && payload.api_app_id !== applicationId) ||
            (payload.team_id !== undefined && payload.team_id !== COCKPIT.workspaceId)) return reject(403, "BLOCKED_PROVIDER_BINDING");
        if (typeof payload.challenge !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(payload.challenge) || /\s/.test(payload.challenge)) return reject(400, "BLOCKED_CHALLENGE");
        return Object.freeze({ state: "URL_CHALLENGE_VERIFIED", shouldDispatch: false, acknowledgement: Object.freeze({ status: 200, body: payload.challenge }) });
      }
      if (payload.type !== "event_callback") return reject(400, "BLOCKED_EVENT_TYPE");
      if (payload.team_id !== COCKPIT.workspaceId || payload.api_app_id !== applicationId) return reject(403, "BLOCKED_PROVIDER_BINDING");
      if (typeof payload.event_id !== "string" || !/^Ev[A-Za-z0-9_-]{1,128}$/.test(payload.event_id) || /\s/.test(payload.event_id)) return reject(400, "BLOCKED_MISSING_PROVIDER_ID");
      const inner = payload.event;
      if (!inner || typeof inner !== "object" || Array.isArray(inner) || inner.type !== "message") return ignore("IGNORED_EVENT_TYPE");
      // Edits, deletes, broadcasts, file shares, bot messages, etc. are not new
      // commands. Do not reinterpret their nested message fields as authority.
      if (inner.subtype !== undefined || inner.bot_id || inner.bot_profile || inner.app_id) return ignore("IGNORED_MESSAGE_SUBTYPE");
      if (inner.team !== undefined && inner.team !== payload.team_id) return reject(403, "BLOCKED_PROVIDER_BINDING");
      const event = normalizeSlackEvent({
        team: payload.team_id, event_id: payload.event_id,
        channel: inner.channel, user: inner.user, ts: inner.ts,
        thread_ts: inner.thread_ts, text: inner.text
      });
      if (!event.accepted) return ignore(event.state);
      // A verified request supplies per-request authenticity. It does not
      // change the persisted subscription state or grant execution approval.
      const plan = planSlackCommandIntake(event, { ...cockpitState, inboundSubscriptionVerified: true });
      return Object.freeze({
        state: plan.state, shouldDispatch: plan.shouldDispatch, event, plan,
        acknowledgement: Object.freeze({ status: 200, body: "ok" })
      });
    }
  });
}

function header(headers, wanted) {
  if (!headers || typeof headers !== "object") return null;
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const matches = entries.filter(([name]) => name.toLowerCase() === wanted);
  return matches.length === 1 && typeof matches[0][1] === "string" ? matches[0][1] : null;
}

function reject(status, state) {
  return Object.freeze({ state, shouldDispatch: false, acknowledgement: Object.freeze({ status, body: "request rejected" }) });
}

function ignore(state) {
  return Object.freeze({ state, shouldDispatch: false, acknowledgement: Object.freeze({ status: 200, body: "ok" }) });
}
