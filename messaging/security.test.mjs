import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInboundContent,
  classifyInboundRequest,
  handoffCandidate,
} from "./security.mjs";
import { sha256 } from "./runtime.mjs";

const base = {
  platform: "slack",
  providerEventId: "event-1",
  providerEventVerified: true,
  senderRef: "provider://user/1",
  contentRef: "private://message/1",
  contentHash: sha256("hello"),
};

test("provider event authenticity is required", () => {
  assert.throws(
    () => normalizeInboundContent({ ...base, providerEventVerified: false }),
    /unverified_provider_event/,
  );
});

test("inbound content carries no authority", () => {
  const result = normalizeInboundContent(base);
  assert.equal(result.trust, "UNTRUSTED_CONTENT");
  assert.equal(result.authority, "NONE");
});

test("mentions become non-executable handoff candidates", () => {
  const result = normalizeInboundContent({ ...base, mentions: ["agent-instance-2"] });
  assert.deepEqual(result.mentions, [
    { ref: "agent-instance-2", disposition: "HANDOFF_CANDIDATE" },
  ]);
});

test("URLs are never auto-opened", () => {
  const result = normalizeInboundContent({ ...base, urls: ["https://example.invalid/a"] });
  assert.equal(result.urls[0].autoOpen, false);
});

test("attachments are quarantined unless independently verified", () => {
  const result = normalizeInboundContent({
    ...base,
    attachments: [{ ref: "private://attachment/1", mediaType: "application/octet-stream" }],
  });
  assert.equal(result.attachments[0].state, "QUARANTINED_UNSCANNED");
  assert.equal(result.attachments[0].executable, false);
});

test("allowlisted sender still cannot authorize a mutation", () => {
  const result = classifyInboundRequest({ operation: "COMMUNICATE", senderAllowlisted: true });
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.match(result.reason, /does_not_grant_mutation_authority/);
});

test("safe classification may proceed without provider mutation", () => {
  assert.equal(classifyInboundRequest({ operation: "READ" }).state, "CLASSIFICATION_ALLOWED");
});

test("handoff candidate requires a separate intent", () => {
  const event = normalizeInboundContent(base);
  const candidate = handoffCandidate({
    event,
    targetAgent: "agent-instance-3",
    summaryRef: "private://summary/1",
  });
  assert.equal(candidate.executable, false);
  assert.equal(candidate.requiresSeparateIntent, true);
});
