import { readFileSync } from "node:fs";
import { sha256 } from "./runtime.mjs";

export const securityPolicy = Object.freeze(
  JSON.parse(readFileSync(new URL("security-policy.json", import.meta.url), "utf8")),
);

export function normalizeInboundContent({
  platform,
  providerEventId,
  providerEventVerified,
  senderRef,
  contentRef,
  contentHash,
  mentions = [],
  urls = [],
  attachments = [],
}) {
  if (!providerEventVerified) throw new Error("unverified_provider_event");
  if (!platform || !providerEventId || !senderRef || !contentRef) {
    throw new Error("inbound_identity_required");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(contentHash ?? "")) {
    throw new Error("content_hash_required");
  }

  return Object.freeze({
    platform,
    providerEventId,
    senderRef,
    contentRef,
    contentHash,
    trust: "UNTRUSTED_CONTENT",
    authority: "NONE",
    mentions: [...new Set(mentions)].map((ref) => ({ ref, disposition: "HANDOFF_CANDIDATE" })),
    urls: [...new Set(urls)].map((ref) => ({ ref, autoOpen: false })),
    attachments: attachments.map((attachment) => ({
      ref: attachment.ref,
      mediaType: attachment.mediaType ?? null,
      hash: attachment.hash ?? null,
      state: attachment.scanState === "VERIFIED_SAFE" ? "VERIFIED_SAFE" : "QUARANTINED_UNSCANNED",
      executable: false,
    })),
  });
}

export function classifyInboundRequest({ operation, senderAllowlisted = false }) {
  const mutating = new Set(["WRITE", "COMMUNICATE", "DEPLOY", "ADMIN", "SECRET", "PUBLIC_EXPOSE"]);
  if (mutating.has(operation)) {
    return {
      state: "REVIEW_REQUIRED",
      reason: senderAllowlisted
        ? "allowlisted_sender_does_not_grant_mutation_authority"
        : "untrusted_message_cannot_authorize_mutation",
    };
  }
  return { state: "CLASSIFICATION_ALLOWED", reason: "read_only_or_observation" };
}

export function handoffCandidate({ event, targetAgent, summaryRef }) {
  if (!/^agent-instance-[1-6]$/.test(targetAgent ?? "")) throw new Error("invalid_target_agent");
  return {
    id: `handoff-candidate:${sha256(`${event.platform}:${event.providerEventId}:${targetAgent}`).slice(7, 31)}`,
    sourceEventRef: event.providerEventId,
    targetAgent,
    summaryRef,
    state: "HANDOFF_CANDIDATE",
    executable: false,
    requiresSeparateIntent: true,
  };
}
