const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected", "completed"]);

export function reconcileState({ operations = [], claims = [], handoffs = [], now = new Date() } = {}) {
  const nowMs = new Date(now).getTime();
  const actions = [];
  for (const operation of operations) {
    const state = String(operation.state ?? operation.result ?? "unknown").toLowerCase();
    if (state === "timeout_unknown" || state === "timeout") {
      actions.push({ operationId: operation.id, action: "VERIFY_PROVIDER_BEFORE_RETRY", reason: "timeout_does_not_prove_failure", destructiveRetryForbidden: true });
    } else if (!TERMINAL.has(state) && operation.leaseExpiresAt && new Date(operation.leaseExpiresAt).getTime() <= nowMs) {
      actions.push({ operationId: operation.id, action: "REACQUIRE_CLAIM_AND_INSPECT", reason: "operation_lease_expired" });
    }
  }
  for (const claim of claims) {
    if (claim.expiresAt && new Date(claim.expiresAt).getTime() <= nowMs && !TERMINAL.has(String(claim.state ?? "").toLowerCase())) {
      actions.push({ claimId: claim.id, action: "REAP_EXPIRED_CLAIM", reason: "claim_expired" });
    }
  }
  for (const handoff of handoffs) {
    const state = String(handoff.state ?? "offered").toLowerCase();
    if (state === "offered" && handoff.expiresAt && new Date(handoff.expiresAt).getTime() <= nowMs) {
      actions.push({ handoffId: handoff.id, action: "MARK_HANDOFF_EXPIRED", reason: "handoff_not_acknowledged" });
    } else if (state === "accepted" && !handoff.completedAt) {
      actions.push({ handoffId: handoff.id, action: "REQUEST_HANDOFF_COMPLETION_RECEIPT", reason: "accepted_without_completion" });
    }
  }
  return {
    schema: "road-collaboration-reconciliation-v1",
    observedAt: new Date(nowMs).toISOString(),
    healthy: actions.length === 0,
    actions,
    invariants: [
      "timeout_unknown_is_not_failure",
      "provider_state_precedes_retry",
      "expired_claims_do_not_grant_authority",
      "accepted_handoff_requires_completion_receipt"
    ]
  };
}

export function normalizeConnectorObservation(observation = {}) {
  const status = String(observation.status ?? "UNKNOWN").toUpperCase();
  if (status.includes("TIMEOUT")) return { ...observation, normalizedStatus: "TIMEOUT_UNKNOWN", retrySafe: false, next: "verify_provider_state" };
  if ((observation.count === 0 || observation.items?.length === 0) && /SUCCESS|READY|OK|200/.test(status)) {
    return { ...observation, normalizedStatus: "EMPTY_OBSERVATION", retrySafe: true, next: "none" };
  }
  if (/AUTH|FORBIDDEN|401|403/.test(status)) return { ...observation, normalizedStatus: "AUTH_REJECTED_NOT_ABSENT", retrySafe: false, next: "repair_auth" };
  if (/SUCCESS|READY|OK|200/.test(status)) return { ...observation, normalizedStatus: "STEP_SUCCEEDED", retrySafe: true, next: "validate_workflow" };
  return { ...observation, normalizedStatus: status || "UNKNOWN", retrySafe: false, next: "inspect" };
}
