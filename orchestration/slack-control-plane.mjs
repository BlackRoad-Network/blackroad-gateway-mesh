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
  plan: "READ",
  run: "WRITE",
  verify: "READ",
  receipt: "READ",
  stop: "ADMIN",
  reconcile: "ADMIN",
  handoff: "COMMUNICATE"
});

const ACTION_CLASSES = new Set([
  "OBSERVE", "READ", "WRITE", "COMMUNICATE", "DEPLOY", "ADMIN", "SECRET", "PUBLIC_EXPOSE"
]);

const NORMALIZED_SLACK_EVENTS = new WeakSet();

function isSlackTimestamp(value) {
  return typeof value === "string" && value.length <= 32 && /^[0-9]+\.[0-9]+$/.test(value) && !/\s/.test(value);
}

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
  ["DEPLOY", /\b(?:deploy|release|ship)\b/i],
  ["PUBLIC_EXPOSURE", /\b(public|funnel|expose|dns|route)\b/i]
]);

const SECRET_MATERIAL = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:github_pat|gh[opusr])_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\btskey-[A-Za-z0-9-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /(?:^|[\s,;])(?:[a-z0-9]+[_ -]+)*(?:authorization|password|passwd|secret|token|api[_ -]?key|access[_ -]?key|client[_ -]?secret|signing[_ -]?secret|webhook[_ -]?secret|private[_ -]?key)\s*[:=]\s*\S{8,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
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
  const actionClass = Object.hasOwn(VERBS, verb) ? VERBS[verb] : null;

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

  let handoff = null;
  if (verb === "handoff") {
    const handoffMatch = /^([^\s]+)\s+([\s\S]+)$/.exec(target);
    if (!handoffMatch || !/^(?:connector-orchestrator|agent-instance-[1-6])$/.test(handoffMatch[1])) {
      return {
        accepted: false,
        state: "BLOCKED_INVALID_HANDOFF",
        verb,
        actionClass,
        reason: "Handoff requires a canonical owner and an exact operation"
      };
    }
    handoff = Object.freeze({ owner: handoffMatch[1], operation: clean(handoffMatch[2]) });
  }

  const risk = HIGH_RISK
    .filter(([, pattern]) => pattern.test(target))
    .map(([name]) => name);
  if (actionClass === "ADMIN" && !risk.includes("ADMIN")) risk.push("ADMIN");

  const readOnly = actionClass === "READ";

  return {
    accepted: true,
    state: readOnly ? "READY_TO_INSPECT" : "AWAITING_AUTHORIZATION",
    verb,
    actionClass,
    target,
    ...(handoff ? { handoff } : {}),
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

  if (event.team !== undefined && event.team !== COCKPIT.workspaceId) {
    return { accepted: false, state: "IGNORED_WRONG_WORKSPACE" };
  }

  if (event.user !== COCKPIT.operatorUserId) {
    return { accepted: false, state: "IGNORED_UNAUTHORIZED_AUTHOR" };
  }

  if (event.bot_id || event.subtype === "bot_message") {
    return { accepted: false, state: "IGNORED_SELF_ECHO" };
  }

  if (event.subtype !== undefined) return { accepted: false, state: "IGNORED_MESSAGE_SUBTYPE" };
  if (!isSlackTimestamp(event.ts) || (event.thread_ts !== undefined && !isSlackTimestamp(event.thread_ts))) {
    return { accepted: false, state: "BLOCKED_INVALID_THREAD" };
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

  const normalized = Object.freeze({
    accepted: true,
    state: command.state,
    kind: "ORCHESTRATION_COMMAND",
    command: Object.freeze({ ...command, risk: Object.freeze([...command.risk]) }),
    source: Object.freeze({
      provider: "slack",
      providerEventId,
      binding: `road+connector://slack/${COCKPIT.workspaceId}/${COCKPIT.channelId}/${clean(event.ts)}`
    }),
    actor: "road://identity/alexa",
    thread: clean(event.thread_ts) || clean(event.ts),
    canonicalEventId: `road://event/${canonicalId}`,
    contentHash: `sha256:${contentHash}`,
    rawContentPersisted: false
  });
  NORMALIZED_SLACK_EVENTS.add(normalized);
  return normalized;
}

export function planSlackCommandIntake(event, cockpitState = {}) {
  if (
    !event
    || event.accepted !== true
    || event.kind !== "ORCHESTRATION_COMMAND"
    || !NORMALIZED_SLACK_EVENTS.has(event)
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

  if (!isSlackTimestamp(event.thread)) {
    return { state: "BLOCKED_INVALID_THREAD", shouldDispatch: false };
  }

  let command = event.command;
  let resolvedPlan = null;
  if (command.verb === "run") {
    const plans = cockpitState.resolvedPlansById;
    const candidate = plans && typeof plans === "object" && Object.hasOwn(plans, command.target)
      ? plans[command.target]
      : null;
    if (!candidate) return { state: "BLOCKED_PLAN_UNRESOLVED", shouldDispatch: false };
    resolvedPlan = normalizeResolvedPlan(command.target, candidate);
    if (!resolvedPlan) return { state: "BLOCKED_INVALID_PLAN", shouldDispatch: false };
    command = {
      ...command,
      actionClass: resolvedPlan.actionClass,
      risk: resolvedPlan.risk,
      requiresApproval: resolvedPlan.actionClass !== "READ" || resolvedPlan.risk.length > 0,
      requiresStrongApproval: resolvedPlan.risk.length > 0
    };
  }
  const approval = cockpitState.approval;
  const approvalMatches = approval
    && approval.approved === true
    && approval.canonicalEventId === event.canonicalEventId
    && approval.contentHash === event.contentHash
    && approval.threadTs === event.thread
    && (!resolvedPlan || approval.planHash === resolvedPlan.planHash);
  const strongApprovalMatches = approvalMatches
    && approval.strength === "STRONG";

  if (command.requiresStrongApproval && !strongApprovalMatches) {
    return {
      state: "AWAITING_STRONG_AUTHORIZATION",
      shouldDispatch: false,
      approvalBoundTo: event.canonicalEventId,
      ...(resolvedPlan ? { resolvedPlanHash: resolvedPlan.planHash } : {}),
      risk: [...command.risk]
    };
  }

  if (command.requiresApproval && !approvalMatches) {
    return {
      state: "AWAITING_AUTHORIZATION",
      shouldDispatch: false,
      approvalBoundTo: event.canonicalEventId,
      ...(resolvedPlan ? { resolvedPlanHash: resolvedPlan.planHash } : {}),
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
    ...(resolvedPlan ? {
      resolvedPlanId: resolvedPlan.id,
      resolvedPlanHash: resolvedPlan.planHash,
      resourceKey: resolvedPlan.resourceKey
    } : {}),
    ...(command.handoff ? { handoff: command.handoff } : {}),
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

  const headSha = clean(event?.pull_request?.head?.sha);
  const updatedAt = clean(event?.pull_request?.updated_at);
  const eventVersion = (action === "synchronize" ? headSha : updatedAt)
    || headSha
    || `${action}:${merged ? "merged" : "unmerged"}`;
  const semanticIdempotencyKey = sha256([
    "github-pr",
    COCKPIT.githubRepository,
    number,
    classification,
    action,
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
    privateListener: evidence.privateListener === true,
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

  const providerAcknowledged = operation.providerAcknowledged === true;
  const readBackVerified = operation.readBackVerified === true;
  const timeoutUnknown = operation.timeoutUnknown === true;

  const outcome = readBackVerified
    ? "SUCCEEDED"
    : timeoutUnknown
      ? "TIMEOUT_UNKNOWN"
      : providerAcknowledged
        ? "PARTIAL"
        : "FAILED";
  const required = ["id", "intentId", "agentId", "connectorId", "actionClass", "resourceKey", "recordedAt"];
  if (required.some((key) => typeof operation[key] !== "string" || !operation[key])) {
    throw new TypeError("canonical receipt identity fields are required");
  }
  if (!ACTION_CLASSES.has(operation.actionClass)) throw new TypeError("invalid receipt action class");
  if (!/^(?:connector-orchestrator|agent-instance-[1-6])$/.test(operation.agentId)) throw new TypeError("invalid receipt agent id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(operation.connectorId)) throw new TypeError("invalid receipt connector id");
  if (!isRfc3339UtcInstant(operation.recordedAt)) {
    throw new TypeError("invalid receipt timestamp");
  }
  for (const key of [
    "claimId", "invocationId", "workflowId", "sessionRef",
    "providerRequestRef", "decisionReceiptRef", "errorClass"
  ]) {
    if (operation[key] !== undefined && operation[key] !== null && typeof operation[key] !== "string") {
      throw new TypeError(`${key} must be a string or null`);
    }
  }
  for (const key of ["evidenceRefs", "validationRefs"]) {
    if (operation[key] !== undefined && (!Array.isArray(operation[key]) || operation[key].some((value) => typeof value !== "string"))) {
      throw new TypeError(`${key} must contain strings`);
    }
  }

  return Object.freeze({
    id: operation.id,
    intentId: operation.intentId,
    claimId: operation.claimId ?? null,
    invocationId: operation.invocationId ?? null,
    workflowId: operation.workflowId ?? null,
    agentId: operation.agentId,
    sessionRef: operation.sessionRef ?? null,
    connectorId: operation.connectorId,
    actionClass: operation.actionClass,
    resourceKey: operation.resourceKey,
    outcome,
    providerRequestRef: operation.providerRequestRef ?? null,
    decisionReceiptRef: operation.decisionReceiptRef ?? null,
    evidenceRefs: Object.freeze(Array.isArray(operation.evidenceRefs) ? [...operation.evidenceRefs] : []),
    validationRefs: Object.freeze(Array.isArray(operation.validationRefs) ? [...operation.validationRefs] : []),
    errorClass: operation.errorClass ?? null,
    summary: outcome === "PARTIAL" ? "provider-acknowledged-awaiting-verification" : null,
    recordedAt: operation.recordedAt
  });
}

function isRfc3339UtcInstant(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function normalizeResolvedPlan(id, plan) {
  if (!plan || typeof plan !== "object" || plan.id !== id || !ACTION_CLASSES.has(plan.actionClass)) return null;
  const resourceKey = clean(plan.resourceKey);
  const planHash = clean(plan.planHash);
  if (!resourceKey || !/^sha256:[a-f0-9]{64}$/.test(planHash)) return null;
  const suppliedRisk = Array.isArray(plan.risk) && plan.risk.every((value) => typeof value === "string")
    ? plan.risk
    : null;
  if (!suppliedRisk) return null;
  const derivedRisk = {
    DEPLOY: "DEPLOY", ADMIN: "ADMIN", SECRET: "SECRET", PUBLIC_EXPOSE: "PUBLIC_EXPOSURE"
  }[plan.actionClass];
  const risk = [...new Set([...suppliedRisk, ...(derivedRisk ? [derivedRisk] : [])])].sort();
  return Object.freeze({ id, actionClass: plan.actionClass, resourceKey, risk: Object.freeze(risk), planHash });
}
