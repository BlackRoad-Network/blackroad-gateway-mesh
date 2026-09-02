import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, journalPath, readJournal, verifyJournal } from "./journal.mjs";
import { normalizeConnectorObservation } from "./reconcile.mjs";

const AGENT_RE = /^agent-instance-[1-6]$/;
const SECRET_KEY_RE = /(secret|password|token|private[_-]?key|api[_-]?key|credential|cookie|authorization)/i;
const KNOWN_TERMINAL = new Set([
  "STEP_SUCCEEDED",
  "STEP_FAILED",
  "EMPTY_OBSERVATION",
  "AUTH_REJECTED_NOT_ABSENT",
  "CANCELLED"
]);

export function defaultFabricStateRoot() {
  return process.env.ROAD_COLLAB_STATE ??
    (process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, "blackroad", "collaboration")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "BlackRoad", "collaboration")
        : join(tmpdir(), `blackroad-${process.getuid?.() ?? "user"}`, "collaboration"));
}

function rejectSecrets(value, path = "input") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (SECRET_KEY_RE.test(key) && item != null && !/ref(s)?$/i.test(key)) {
      throw Object.assign(new Error(`secret_value_forbidden:${here}`), { code: "SECRET_VALUE_FORBIDDEN" });
    }
    if (typeof item === "object") rejectSecrets(item, here);
  }
}

function requireAgent(agentId) {
  if (!AGENT_RE.test(agentId ?? "")) {
    throw Object.assign(new Error("invalid_agent_id"), { code: "INVALID_AGENT_ID" });
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field}_required`), { code: "INVALID_REQUEST" });
  }
  return value;
}

function latestBy(records, key) {
  const map = new Map();
  for (const record of records) map.set(record[key], record);
  return map;
}

export class CollaborationFabric {
  constructor(options = {}) {
    this.stateRoot = options.stateRoot ?? defaultFabricStateRoot();
    this.paths = {
      results: journalPath(this.stateRoot, "connector-results"),
      heartbeats: journalPath(this.stateRoot, "session-heartbeats"),
      checkpoints: journalPath(this.stateRoot, "workflow-checkpoints")
    };
  }

  async submitConnectorResult(input) {
    rejectSecrets(input);
    requireAgent(input.agentId);
    requireText(input.sessionId, "session_id");
    requireText(input.connector, "connector");
    requireText(input.target, "target");
    requireText(input.operation, "operation");
    requireText(input.status, "status");

    const mutating = (input.mode ?? "read") !== "read";
    if (mutating && !input.claimRef) {
      throw Object.assign(new Error("claim_ref_required_for_mutation"), { code: "CLAIM_REQUIRED" });
    }

    const normalized = normalizeConnectorObservation({
      status: input.status,
      count: input.count,
      items: input.items
    });
    const versionConflict = Boolean(
      input.expectedVersion &&
      input.providerVersionBefore &&
      input.expectedVersion !== input.providerVersionBefore
    );
    const normalizedStatus = versionConflict ? "CONFLICT" : normalized.normalizedStatus;
    const claimMayClose = KNOWN_TERMINAL.has(normalizedStatus);

    return appendJournal(this.paths.results, {
      schema: "road-connector-observation-v1",
      receiptId: `connector_receipt_${randomUUID()}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      planId: input.planId ?? null,
      planHash: input.planHash ?? null,
      workflowId: input.workflowId ?? null,
      stepId: input.stepId ?? null,
      connector: input.connector,
      target: input.target,
      resourceKey: input.resourceKey ?? `${input.connector}::${input.target}`,
      operation: input.operation,
      mode: input.mode ?? "read",
      claimRef: input.claimRef ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      expectedVersion: input.expectedVersion ?? null,
      providerVersionBefore: input.providerVersionBefore ?? null,
      providerVersionAfter: input.providerVersionAfter ?? null,
      providerStatus: input.status,
      normalizedStatus,
      evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
      correlationId: input.correlationId ?? `corr_${randomUUID()}`,
      causationId: input.causationId ?? null,
      retrySafe: normalized.retrySafe && normalizedStatus !== "CONFLICT",
      requiresProviderInspection: normalizedStatus === "TIMEOUT_UNKNOWN" || normalizedStatus === "CONFLICT",
      claimMayClose,
      secretRefs: [...new Set(input.secretRefs ?? [])],
      secretValuesPersisted: false
    });
  }

  async heartbeat(input) {
    rejectSecrets(input);
    requireAgent(input.agentId);
    requireText(input.sessionId, "session_id");
    const ttlSeconds = Number(input.ttlSeconds ?? 90);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 3600) {
      throw Object.assign(new Error("ttl_seconds_out_of_range"), { code: "INVALID_TTL" });
    }
    return appendJournal(this.paths.heartbeats, {
      schema: "road-agent-heartbeat-v1",
      heartbeatId: `heartbeat_${randomUUID()}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      runtime: input.runtime ?? null,
      model: input.model ?? null,
      activeClaimRefs: [...new Set(input.activeClaimRefs ?? [])],
      workflowRefs: [...new Set(input.workflowRefs ?? [])],
      ttlSeconds,
      authorityGrantedByHeartbeat: false,
      secretValuesPersisted: false
    });
  }

  async listStaleSessions(input = {}) {
    const now = new Date(input.now ?? Date.now());
    if (Number.isNaN(now.getTime())) throw Object.assign(new Error("invalid_now"), { code: "INVALID_DATE" });
    const records = await readJournal(this.paths.heartbeats);
    const latest = latestBy(records, "sessionId");
    const sessions = [...latest.values()].map((heartbeat) => {
      const expiresAt = new Date(new Date(heartbeat.recordedAt).getTime() + heartbeat.ttlSeconds * 1000);
      const stale = expiresAt.getTime() <= now.getTime();
      return {
        agentId: heartbeat.agentId,
        sessionId: heartbeat.sessionId,
        lastHeartbeatAt: heartbeat.recordedAt,
        expiresAt: expiresAt.toISOString(),
        state: stale ? "STALE_OBSERVED" : "ACTIVE_OBSERVED",
        activeClaimRefs: heartbeat.activeClaimRefs,
        workflowRefs: heartbeat.workflowRefs,
        authorityRevokedAutomatically: false,
        note: stale
          ? "Claims remain governed by their own lease expiry and are not force-released by heartbeat absence."
          : null
      };
    });
    return {
      schema: "road-agent-session-observation-v1",
      observedAt: now.toISOString(),
      sessions,
      staleCount: sessions.filter((session) => session.state === "STALE_OBSERVED").length
    };
  }

  async checkpointWorkflow(input) {
    rejectSecrets(input);
    requireAgent(input.agentId);
    requireText(input.sessionId, "session_id");
    requireText(input.workflowId, "workflow_id");
    requireText(input.stepId, "step_id");
    requireText(input.state, "state");
    return appendJournal(this.paths.checkpoints, {
      schema: "road-workflow-checkpoint-v1",
      checkpointId: `checkpoint_${randomUUID()}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      stepId: input.stepId,
      state: input.state,
      connector: input.connector ?? null,
      target: input.target ?? null,
      receiptRef: input.receiptRef ?? null,
      dependsOn: [...new Set(input.dependsOn ?? [])],
      evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      secretValuesPersisted: false
    });
  }

  async workflowStatus(workflowId) {
    requireText(workflowId, "workflow_id");
    const records = (await readJournal(this.paths.checkpoints)).filter((record) => record.workflowId === workflowId);
    const latest = latestBy(records, "stepId");
    const steps = [...latest.values()].sort((a, b) => a.stepId.localeCompare(b.stepId));
    return {
      schema: "road-workflow-status-v1",
      workflowId,
      observedAt: new Date().toISOString(),
      steps,
      counts: steps.reduce((acc, step) => {
        acc[step.state] = (acc[step.state] ?? 0) + 1;
        return acc;
      }, {}),
      complete: steps.length > 0 && steps.every((step) => ["SUCCEEDED", "EMPTY_OBSERVATION", "CANCELLED", "FAILED"].includes(step.state))
    };
  }

  async verify() {
    const entries = {};
    let ok = true;
    for (const [name, path] of Object.entries(this.paths)) {
      const records = await readJournal(path);
      entries[name] = verifyJournal(records);
      ok = ok && entries[name].ok;
    }
    return {
      schema: "road-collaboration-fabric-verification-v1",
      ok,
      stateRoot: this.stateRoot,
      journals: entries,
      secretValuesPersisted: false
    };
  }
}

export const fabricInternals = { rejectSecrets, latestBy, KNOWN_TERMINAL };
