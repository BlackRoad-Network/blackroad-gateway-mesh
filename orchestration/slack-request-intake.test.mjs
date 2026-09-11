import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { COCKPIT, normalizeSlackEvent, parseRoadCommand, planSlackCommandIntake } from "./slack-control-plane.mjs";
import { createSlackRequestIntake } from "./slack-request-intake.mjs";

const SECRET = "test-only-signing-key-never-used-with-a-provider";
const APP = "ATEST1729";
const NOW = 1_788_943_756_000;
const intake = (options = {}) => createSlackRequestIntake({ signingSecret: SECRET, applicationId: APP, clock: () => NOW, ...options });
const payload = (text = "road status github") => ({
  type: "event_callback", team_id: COCKPIT.workspaceId, api_app_id: APP,
  event_id: "Ev1729", event: {
    type: "message", channel: COCKPIT.channelId, user: COCKPIT.operatorUserId,
    ts: "1788943756.716919", thread_ts: "1788943700.123456", text
  }
});
function signed(value, timestamp = String(NOW / 1_000)) {
  const rawBody = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const signature = "v0=" + createHmac("sha256", SECRET).update(`v0:${timestamp}:`).update(rawBody).digest("hex");
  return { method: "POST", rawBody, headers: { "Content-Type": "application/json", "X-Slack-Signature": signature, "X-Slack-Request-Timestamp": timestamp } };
}

test("accepts Slack's published signature vector before rejecting its non-JSON content type", () => {
  // Public fixture: https://docs.slack.dev/authentication/verifying-requests-from-slack/
  const verifier = intake({ signingSecret: "8f742231b10e8888abcd99yyyzzz85a5", clock: () => 1_531_420_618_000 });
  const rawBody = Buffer.from("token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c");
  const result = verifier.handle({ method: "POST", rawBody, headers: {
    "x-slack-request-timestamp": "1531420618",
    "x-slack-signature": "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    "content-type": "application/x-www-form-urlencoded"
  } });
  assert.equal(result.state, "BLOCKED_CONTENT_TYPE");
});

test("authenticated callbacks produce an exact-thread read plan without provider execution", () => {
  const result = intake().handle(signed(payload()));
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.plan.operationThreadTs, "1788943700.123456");
  assert.equal(result.plan.exactTarget, "github");
  assert.equal(result.event.source.providerEventId, "Ev1729");
  assert.deepEqual(result.plan.automaticProviderMutations, []);
  assert.equal(result.acknowledgement.status, 200);
  assert.equal(result.event.rawContentPersisted, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("signature validation uses original bytes including whitespace and unicode", () => {
  const data = payload("road plan Lucidia 💚");
  const original = Buffer.from(JSON.stringify(data, null, 2));
  const request = signed(original);
  assert.equal(intake().handle(request).state, "READY_TO_DISPATCH");
  request.rawBody = Buffer.from(JSON.stringify(data));
  assert.equal(intake().handle(request).state, "BLOCKED_REQUEST_SIGNATURE");
  request.rawBody = Buffer.from(original.toString().replace("Lucidia", "Sophia"));
  assert.equal(intake().handle(request).state, "BLOCKED_REQUEST_SIGNATURE");
});

test("rejects stale, future, malformed, or missing signing metadata", () => {
  for (const offset of [-301, 301]) assert.equal(intake().handle(signed(payload(), String(NOW / 1_000 + offset))).state, "BLOCKED_REQUEST_AGE");
  for (const offset of [-300, 300]) assert.equal(intake().handle(signed(payload(), String(NOW / 1_000 + offset))).state, "READY_TO_DISPATCH");
  for (const value of [undefined, null, [], 123, "", "v1=" + "a".repeat(64), "v0=" + "0".repeat(64), "v0=bad"]) {
    const request = signed(payload());
    request.headers["X-Slack-Signature"] = value;
    assert.equal(intake().handle(request).state, "BLOCKED_REQUEST_SIGNATURE");
  }
  for (const timestamp of ["", "0", "001788943756", "1788943756\n", "1788943756.0", "1e9"]) {
    assert.notEqual(intake().handle(signed(payload(), timestamp)).shouldDispatch, true);
  }
});

test("header names are case insensitive and duplicate signing headers fail closed", () => {
  const request = signed(payload());
  request.headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(intake().handle(request).shouldDispatch, true);
  assert.equal(intake().handle({ ...request, headers: new Headers(request.headers) }).shouldDispatch, true);
  request.headers["X-Slack-Signature"] = request.headers["x-slack-signature"];
  assert.equal(intake().handle(request).state, "BLOCKED_REQUEST_SIGNATURE");
});

test("rejects unsupported methods, parsed bodies, oversized inputs, bad JSON, and invalid UTF-8", () => {
  assert.equal(intake().handle({ ...signed(payload()), method: "GET" }).acknowledgement.status, 405);
  assert.equal(intake().handle({ ...signed(payload()), rawBody: payload() }).state, "BLOCKED_RAW_BODY_REQUIRED");
  assert.equal(intake({ maxBodyBytes: 10 }).handle(signed(payload())).acknowledgement.status, 413);
  for (const body of [Buffer.from("{"), Buffer.from([0xff, 0xfe])]) assert.equal(intake().handle(signed(body)).state, "BLOCKED_INVALID_JSON");
  for (const body of [null, [], 42, "text"]) assert.equal(intake().handle(signed(body)).state, "BLOCKED_INVALID_ENVELOPE");
  const unsigned = signed(Buffer.from("{"));
  unsigned.headers["X-Slack-Signature"] = "v0=" + "0".repeat(64);
  assert.equal(intake().handle(unsigned).state, "BLOCKED_REQUEST_SIGNATURE");
});

test("requires the configured app, workspace, channel, and operator", () => {
  for (const key of ["team_id", "api_app_id"]) {
    for (const value of [undefined, "OTHER"]) {
      const data = payload(); data[key] = value;
      assert.equal(intake().handle(signed(data)).state, "BLOCKED_PROVIDER_BINDING");
    }
  }
  for (const [key, value, expected] of [["channel", "COTHER", "IGNORED_WRONG_CHANNEL"], ["user", "UOTHER", "IGNORED_UNAUTHORIZED_AUTHOR"], ["team", "TOTHER", "BLOCKED_PROVIDER_BINDING"]]) {
    const data = payload(); data.event[key] = value;
    assert.equal(intake().handle(signed(data)).state, expected);
  }
});

test("uses the outer provider event ID and rejects missing IDs or ambiguous timestamps", () => {
  const data = payload(); data.event.event_id = "EvSpoofedInnerId";
  assert.equal(intake().handle(signed(data)).event.source.providerEventId, "Ev1729");
  delete data.event_id;
  assert.equal(intake().handle(signed(data)).state, "BLOCKED_MISSING_PROVIDER_ID");
  for (const field of ["ts", "thread_ts"]) {
    for (const value of [null, 123, "", "1.1\n", "bad"]) {
      const malformed = payload(); malformed.event[field] = value;
      assert.equal(intake().handle(signed(malformed)).state, "BLOCKED_INVALID_THREAD");
    }
  }
});

test("message edits, deletes, bot echoes and other event types cannot become new commands", () => {
  for (const subtype of ["message_changed", "message_deleted", "thread_broadcast", "file_share", "bot_message", null, ""]) {
    const data = payload(); data.event.subtype = subtype;
    assert.equal(intake().handle(signed(data)).state, "IGNORED_MESSAGE_SUBTYPE");
  }
  for (const type of ["app_mention", "reaction_added", undefined]) {
    const data = payload(); data.event.type = type;
    assert.equal(intake().handle(signed(data)).state, "IGNORED_EVENT_TYPE");
  }
});

test("signed requests never grant write approval and ignore caller evidence inside the payload", () => {
  const data = payload("road run approved-plan-1729");
  data.approval = { approved: true, strength: "STRONG" };
  data.inboundSubscriptionVerified = true;
  const handler = intake();
  const waiting = handler.handle(signed(data));
  assert.equal(waiting.state, "AWAITING_AUTHORIZATION");
  const { event } = waiting;
  const approval = { approved: true, canonicalEventId: event.canonicalEventId, contentHash: event.contentHash, threadTs: event.thread };
  assert.equal(handler.handle(signed(data), { approval }).state, "READY_TO_DISPATCH");
  assert.equal(handler.handle(signed(data), { approval: { ...approval, contentHash: "sha256:stale" } }).state, "AWAITING_AUTHORIZATION");
  const changed = payload("road run deploy service");
  assert.equal(handler.handle(signed(changed), { approval }).state, "AWAITING_STRONG_AUTHORIZATION");
  const highRisk = handler.handle(signed(changed)).event;
  const strong = { approved: true, strength: "STRONG", canonicalEventId: highRisk.canonicalEventId, contentHash: highRisk.contentHash, threadTs: highRisk.thread };
  assert.equal(handler.handle(signed(changed), { approval: strong }).state, "READY_TO_DISPATCH");
});

test("signed provider redelivery remains a no-op once recorded by the host", () => {
  const handler = intake();
  const first = handler.handle(signed(payload()));
  const redelivery = handler.handle(signed(Buffer.from(JSON.stringify(payload(), null, 2))), { seenCanonicalEventIds: [first.event.canonicalEventId] });
  assert.equal(redelivery.state, "NOOP_DUPLICATE_COMMAND");
  assert.equal(redelivery.shouldDispatch, false);
});

test("signed URL challenges never dispatch and unsigned challenges are rejected", () => {
  const data = { type: "url_verification", challenge: "sample-challenge-1729" };
  const response = intake().handle(signed(data));
  assert.equal(response.state, "URL_CHALLENGE_VERIFIED");
  assert.equal(response.acknowledgement.body, data.challenge);
  assert.equal(response.shouldDispatch, false);
  assert.equal("plan" in response, false);
  const unsigned = signed(data); delete unsigned.headers["X-Slack-Signature"];
  assert.equal(intake().handle(unsigned).acknowledgement.status, 401);
  assert.equal(intake().handle(signed({ ...data, api_app_id: "AOTHER" })).state, "BLOCKED_PROVIDER_BINDING");
});

test("secret-like command targets and provider error inputs are not returned", () => {
  const result = intake().handle(signed(payload("road run token=private-value-1729")));
  assert.equal(result.state, "BLOCKED_SECRET_MATERIAL");
  assert.doesNotMatch(JSON.stringify(result), /private-value|token=|test-only-signing/);
});

test("normalized command policy is immutable and cloned or forged envelopes are not trusted", () => {
  const data = payload("road run deploy service");
  const event = normalizeSlackEvent({ ...data.event, event_id: data.event_id });
  assert.throws(() => { event.command.requiresApproval = false; }, TypeError);
  assert.throws(() => { event.command.target = "different-target"; }, TypeError);
  assert.throws(() => { event.command.risk.length = 0; }, TypeError);
  const forged = { ...event, command: { ...event.command, requiresApproval: false, requiresStrongApproval: false } };
  assert.equal(planSlackCommandIntake(forged, { inboundSubscriptionVerified: true }).state, "BLOCKED_INVALID_EVENT");
  assert.equal(planSlackCommandIntake(JSON.parse(JSON.stringify(event)), { inboundSubscriptionVerified: true }).state, "BLOCKED_INVALID_EVENT");
});

test("prototype properties are not Road command verbs", () => {
  for (const verb of ["constructor", "toString", "hasOwnProperty"]) assert.equal(parseRoadCommand(`road ${verb} github`).state, "BLOCKED_UNKNOWN_COMMAND");
});

test("invalid local configuration fails before accepting requests", () => {
  assert.throws(() => createSlackRequestIntake(), /signingSecret/);
  assert.throws(() => intake({ applicationId: "" }), /applicationId/);
  assert.throws(() => intake({ maxBodyBytes: 0 }), /maxBodyBytes/);
  assert.equal(intake({ clock: () => NaN }).handle(signed(payload())).state, "BLOCKED_CLOCK");
});
