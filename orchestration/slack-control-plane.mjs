import { createHash } from "node:crypto";

export const COCKPIT = Object.freeze({
  workspaceId: "T09BC6BSEDV",
  channelId: "C0A2M4K8WLB",
  operatorUserId: "U09BC6BT3N3",
  githubRepository: "BlackRoad-Network/blackroad-gateway-mesh",
  modelRoadUri: "road://service/models",
  modelService: "svc:models"
});

const VERBS = Object.freeze({
  status: "READ",
  plan: "PLAN",
  run: "EXECUTE",
  verify: "VERIFY",
  receipt: "READ",
  stop: "STOP",
  reconcile: "RECONCILE",
  handoff: "HANDOFF"
});

const GITHUB_PR_ACTIONS = Object.freeze({
  opened: "OPENED",
  ready_for_review: "READY",
  synchronize: "UPDATED",
  reopened: "UPDATED",
  edited: "UPDATED",
  converted_to_draft: "UPDATED"
});

const HIGH_RISK = Object.freeze([
  ["DESTRUCTIVE", /\b(delete|destroy|purge|erase|drop|wipe)\b/i],
  ["ADMIN", /\b(admin|owner|root|sudo|policy)\b/i],
  ["FINANCIAL", /\b(pay|payment|charge|refund|invoice|bank|tax)\b/i],
  ["SECRET", /\b(secret|token|credential|password|private[ -]?key)\b/i],
  ["IDENTITY", /\b(identity|user|member|role|permission)\b/i],
  ["ACCESS_CONTROL", /\b(grant|acl|access|authorize|revoke)\b/i],
  ["MERGE", /\bmerge\b/i],
  ["DEPLOY", /\bdeploy|release|ship\b/i],
  ["PUBLIC_EXPOSURE", /\b(public|funnel|expose|dns|route)\b/i]
]);

const SECRET_MATERIAL = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:github_pat|gh[opusr])_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\btskey-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:authorization|password|passwd|secret|token)\s*[:=]\s*\S{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseRoadCommand(text) {
  const input = clean(text);
  const match = /^road\s+([a-z-]+)(?:\s+([\s\S]+))?$/i.exec(input);

  if (!match) {
    return {
      accepted: false,
      state: "BLOCKED_UNKNOWN_COMMAND",
      reason: "Commands must begin with: road <verb> <target>"
    };
  }

  const verb = match[1].toLowerCase();
  const target = clean(match[2]);
  const actionClass = VERBS[verb];

  if (!actionClass) {
    return {
      accepted: false,
      state: "BLOCKED_UNKNOWN_COMMAND",
      verb,
      reason: "Unknown Road command verb"
    };
  }

  if (!target) {
    return {
      accepted: false,
      state: "BLOCKED_MISSING_TARGET",
      verb,
      actionClass,
      reason: "An exact target or goal is required"
    };
  }

  if (SECRET_MATERIAL.some((pattern) => pattern.test(target))) {
    return {
      accepted: false,
      state: "BLOCKED_SECRET_MATERIAL",
      verb,
      actionClass,
      reason: "Secret-like material must not enter Slack commands"
    };
  }

  const risk = HIGH_RISK
    .filter(([, pattern]) => pattern.test(target))
    .map(([name]) => name);

  const readOnly = new Set(["READ", "PLAN", "VERIFY", "RECONCILE"]).has(actionClass);

  return {
    accepted: true,
    state: readOnly ? "READY_TO_INSPECT" : "AWAITING_AUTHORIZATION",
    verb,
    actionClass,
    target,
    risk,
    requiresApproval: !readOnly || risk.length > 0,
    requiresStrongApproval: risk.length > 0
  };
}

export function normalizeSlackEvent(event) {
  if (!event || typeof event !== "object") {
    return { accepted: false, state: "BLOCKED_INVALID_EVENT" };
  }

  if (event.channel !== COCKPIT.channelId) {
    return { accepted: false, state: "IGNORED_WRONG_CHANNEL" };
  }

  if (event.user !== COCKPIT.operatorUserId) {
    return { accepted: false, state: "IGNORED_UNAUTHORIZED_AUTHOR" };
  }

  if (event.bot_id || event.subtype === "bot_message") {
    return { accepted: false, state: "IGNORED_SELF_ECHO" };
  }

  const command = parseRoadCommand(event.text);
  if (!command.accepted) return command;

  const providerEventId = clean(event.event_id) || clean(event.ts);
  if (!providerEventId) {
    return { accepted: false, state: "BLOCKED_MISSING_PROVIDER_ID" };
  }

  const contentHash = sha256(clean(event.text));
  const canonicalId = sha256([
    "slack",
    COCKPIT.workspaceId,
    COCKPIT.channelId,
    providerEventId,
    contentHash
  ].join(":"));

  return {
    accepted: true,
    state: command.state,
    kind: "ORCHESTRATION_COMMAND",
    command,
    source: {
      provider: "slack",
      providerEventId,
      binding: `road+connector://slack/${COCKPIT.workspaceId}/${COCKPIT.channelId}/${clean(event.ts)}`
    },
    actor: "road://identity/alexa",
    thread: clean(event.thread_ts) || clean(event.ts),
    canonicalEventId: `road://event/${canonicalId}`,
    contentHash: `sha256:${contentHash}`,
    rawContentPersisted: false
  };
}

export function planSlackCommandIntake(event, cockpitState = {}) {
  if (
    !event
    || event.accepted !== true
    || event.kind !== "ORCHESTRATION_COMMAND"
  ) {
    return { state: "BLOCKED_INVALID_EVENT", shouldDispatch: false };
  }

  const seen = new Set(
    Array.isArray(cockpitState.seenCanonicalEventIds)
      ? cockpitState.seenCanonicalEventIds
      : []
  );
  if (seen.has(event.canonicalEventId)) {
    return {
      state: "NOOP_DUPLICATE_COMMAND",
      shouldDispatch: false,
      duplicateKey: event.canonicalEventId
    };
  }

  if (cockpitState.inboundSubscriptionVerified !== true) {
    return {
      state: "BLOCKED_INBOUND_UNVERIFIED",
      shouldDispatch: false,
      missing: ["inboundSubscriptionVerified"]
    };
  }

  if (!/^\d+\.\d+$/.test(event.thread)) {
    return { state: "BLOCKED_INVALID_THREAD", shouldDispatch: false };
  }

  const command = event.command;
  const approval = cockpitState.approval;
  const approvalMatches = approval
    && approval.approved === true
    && approval.canonicalEventId === event.canonicalEventId
    && approval.contentHash === event.contentHash
    && approval.threadTs === event.thread;
  const strongApprovalMatches = approvalMatches
    && approval.strength === "STRONG";

  if (command.requiresStrongApproval && !strongApprovalMatches) {
    return {
      state: "AWAITING_STRONG_AUTHORIZATION",
      shouldDispatch: false,
      approvalBoundTo: event.canonicalEventId,
      risk: [...command.risk]
    };
  }

  if (command.requiresApproval && !approvalMatches) {
    return {
      state: "AWAITING_AUTHORIZATION",
      shouldDispatch: false,
      approvalBoundTo: event.canonicalEventId,
      risk: [...command.risk]
    };
  }

  return {
    schema: "road-slack-command-envelope-v1",
    state: "READY_TO_DISPATCH",
    shouldDispatch: true,
    actionClass: command.actionClass,
    verb: command.verb,
    exactTarget: command.target,
    operationThreadTs: event.thread,
    sourceEvent: event.canonicalEventId,
    contentHash: event.contentHash,
    actor: event.actor,
    automaticProviderMutations: [],
    rawContentPersisted: false,
    recordAfterVerifiedReceipt: {
      canonicalEventId: event.canonicalEventId,
      threadTs: event.thread
    }
  };
}

export function normalizeGitHubPullRequestEvent(event) {
  const repository = clean(event?.repository?.full_name);
  if (repository.toLowerCase() !== COCKPIT.githubRepository.toLowerCase()) {
    return { accepted: false, state: "IGNORED_WRONG_REPOSITORY" };
  }

  const action = clean(event?.action).toLowerCase();
  const number = Number(event?.pull_request?.number ?? event?.number);
  const delivery = clean(event?.delivery_id) || clean(event?.event_id);

  if (!action || !Number.isInteger(number) || number < 1 || !delivery) {
    return { accepted: false, state: "BLOCKED_INVALID_EVENT" };
  }

  const merged = event?.pull_request?.merged === true;
  const classification = action === "closed"
    ? merged ? "MERGED" : "CLOSED"
    : GITHUB_PR_ACTIONS[action];

  if (!classification) {
    return {
      accepted: false,
      state: "BLOCKED_UNSUPPORTED_ACTION",
      action
    };
  }

  const eventVersion = clean(event?.pull_request?.head?.sha)
    || clean(event?.pull_request?.updated_at)
    || `${action}:${merged ? "merged" : "unmerged"}`;
  const semanticIdempotencyKey = sha256([
    "github-pr",
    COCKPIT.githubRepository,
    number,
    classification,
    eventVersion
  ].join(":"));
  const deliveryIdempotencyKey = sha256([
    "github-delivery",
    COCKPIT.githubRepository,
    delivery
  ].join(":"));

  return {
    accepted: true,
    state: "READY_TO_REPORT",
    kind: "GITHUB_PULL_REQUEST_EVENT",
    classification,
    source: {
      provider: "github",
      repository: COCKPIT.githubRepository,
      action,
      pullRequest: number,
      delivery,
      eventVersion
    },
    destination: `road+connector://slack/channel/${COCKPIT.channelId}`,
    marker: `[github:${COCKPIT.githubRepository}#${number}]`,
    automaticProviderMutations: [],
    idempotencyKey: semanticIdempotencyKey,
    semanticIdempotencyKey,
    deliveryIdempotencyKey
  };
}

export function planGitHubSlackDelivery(event, cockpitState = {}) {
  if (
    !event
    || event.accepted !== true
    || event.kind !== "GITHUB_PULL_REQUEST_EVENT"
  ) {
    return {
      state: "BLOCKED_INVALID_EVENT",
      shouldPost: false
    };
  }

  const seenDeliveryKeys = new Set(
    Array.isArray(cockpitState.seenDeliveryKeys)
      ? cockpitState.seenDeliveryKeys
      : []
  );
  const seenSemanticKeys = new Set(
    Array.isArray(cockpitState.seenSemanticKeys)
      ? cockpitState.seenSemanticKeys
      : []
  );

  if (seenDeliveryKeys.has(event.deliveryIdempotencyKey)) {
    return {
      state: "NOOP_DUPLICATE_DELIVERY",
      shouldPost: false,
      duplicateKey: event.deliveryIdempotencyKey
    };
  }

  if (seenSemanticKeys.has(event.semanticIdempotencyKey)) {
    return {
      state: "NOOP_DUPLICATE_SEMANTIC_EVENT",
      shouldPost: false,
      duplicateKey: event.semanticIdempotencyKey
    };
  }

  const parentsByMarker = cockpitState.parentsByMarker
    && typeof cockpitState.parentsByMarker === "object"
    ? cockpitState.parentsByMarker
    : {};
  const threadTs = clean(parentsByMarker[event.marker]);

  return {
    state: "READY_TO_POST",
    shouldPost: true,
    mode: threadTs ? "THREAD" : "PARENT",
    channelId: COCKPIT.channelId,
    threadTs: threadTs || null,
    marker: event.marker,
    classification: event.classification,
    recordAfterVerifiedWrite: {
      deliveryKey: event.deliveryIdempotencyKey,
      semanticKey: event.semanticIdempotencyKey,
      parentMarker: event.marker
    }
  };
}

export function planOllamaDispatch(evidence = {}) {
  const required = {
    tailnetNodeIdentity: Boolean(evidence.tailnetNodeIdentity),
    serviceOwnership: evidence.serviceOwnership === COCKPIT.modelService,
    privateListener: Boolean(evidence.privateListener),
    modelInventory: Array.isArray(evidence.modelInventory) && evidence.modelInventory.length > 0,
    boundedInference: evidence.boundedInference === true
  };

  const missing = Object.entries(required)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  if (missing.length) {
    return {
      state: "BLOCKED_OFFLINE",
      roadUri: COCKPIT.modelRoadUri,
      tailscaleService: COCKPIT.modelService,
      visibility: "tailnet-only",
      publicFallback: false,
      paidFallback: false,
      missing
    };
  }

  return {
    state: "READY_PRIVATE",
    roadUri: COCKPIT.modelRoadUri,
    tailscaleService: COCKPIT.modelService,
    visibility: "tailnet-only",
    publicFallback: false,
    paidFallback: false,
    verifiedModels: [...evidence.modelInventory]
  };
}

export function buildReceipt(operation) {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("operation is required");
  }

  const providerAcknowledged = Boolean(operation.providerAcknowledged);
  const readBackVerified = Boolean(operation.readBackVerified);
  const timeoutUnknown = operation.timeoutUnknown === true;

  const state = timeoutUnknown
    ? "TIMEOUT_UNKNOWN"
    : providerAcknowledged && readBackVerified
      ? "COMPLETED"
      : providerAcknowledged
        ? "WAITING_VERIFICATION"
        : "FAILED";

  return {
    schema: "road-operation-receipt-v1",
    state,
    retryAllowed: state === "FAILED",
    reconcileRequired: state === "TIMEOUT_UNKNOWN",
    providerAcknowledged,
    readBackVerified,
    evidence: Array.isArray(operation.evidence) ? operation.evidence : []
  };
}
