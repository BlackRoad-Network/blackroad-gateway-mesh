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

export function normalizeGitHubPullRequestEvent(event) {
  const repository = clean(event?.repository?.full_name);
  if (repository.toLowerCase() !== COCKPIT.githubRepository.toLowerCase()) {
    return { accepted: false, state: "IGNORED_WRONG_REPOSITORY" };
  }

  const action = clean(event?.action);
  const number = Number(event?.pull_request?.number ?? event?.number);
  const delivery = clean(event?.delivery_id) || clean(event?.event_id);

  if (!action || !Number.isInteger(number) || number < 1 || !delivery) {
    return { accepted: false, state: "BLOCKED_INVALID_EVENT" };
  }

  return {
    accepted: true,
    state: "READY_TO_REPORT",
    kind: "GITHUB_PULL_REQUEST_EVENT",
    source: {
      provider: "github",
      repository: COCKPIT.githubRepository,
      action,
      pullRequest: number,
      delivery
    },
    destination: `road+connector://slack/channel/${COCKPIT.channelId}`,
    marker: `[github:${COCKPIT.githubRepository}#${number}]`,
    automaticProviderMutations: [],
    idempotencyKey: sha256(["github", COCKPIT.githubRepository, number, action, delivery].join(":"))
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
