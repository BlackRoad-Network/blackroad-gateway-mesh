import { createHash, randomUUID } from "node:crypto";
import { normalizeConnectorObservation } from "./reconcile.mjs";

const SENSITIVE_KEY = /(secret|password|token|private[_-]?key|api[_-]?key|credential|cookie|authorization)/i;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function assertReferenceOnly(value, path = "execution") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && item != null && !/ref(s)?$/i.test(key)) {
      throw Object.assign(new Error(`inline_secret_forbidden:${path}.${key}`), { code: "SECRET_VALUE_FORBIDDEN" });
    }
    if (typeof item === "object") assertReferenceOnly(item, `${path}.${key}`);
  }
}

export class ConnectorAdapterRegistry {
  #adapters = new Map();

  register(connector, adapter) {
    if (!connector || !adapter || typeof adapter.execute !== "function") {
      throw Object.assign(new Error("connector_and_execute_adapter_required"), { code: "INVALID_ADAPTER" });
    }
    if (this.#adapters.has(connector)) {
      throw Object.assign(new Error(`adapter_already_registered:${connector}`), { code: "ADAPTER_CONFLICT" });
    }
    this.#adapters.set(connector, adapter);
    return this;
  }

  get(connector) {
    const adapter = this.#adapters.get(connector);
    if (!adapter) throw Object.assign(new Error(`adapter_not_registered:${connector}`), { code: "ADAPTER_NOT_FOUND" });
    return adapter;
  }

  list() {
    return [...this.#adapters.keys()].sort();
  }
}

export async function executeDispatchPlan({
  plan,
  adapters,
  claimRef = null,
  payloadRef = null,
  secretRefs = [],
  correlationId = `corr_${randomUUID()}`,
  causationId = null
}) {
  assertReferenceOnly({ payloadRef, secretRefs });
  if (!plan?.canDispatch) throw Object.assign(new Error("dispatch_plan_blocked"), { code: "DISPATCH_BLOCKED", blockedBy: plan?.blockedBy ?? [] });
  if (plan.claimRequired && !claimRef) throw Object.assign(new Error("exclusive_claim_required"), { code: "CLAIM_REQUIRED" });
  if (plan.expectedVersionRequired && !plan.expectedVersion) throw Object.assign(new Error("expected_provider_version_required"), { code: "VERSION_FENCE_REQUIRED" });

  const adapter = adapters.get(plan.connector);
  const startedAt = new Date().toISOString();
  let raw;
  try {
    raw = await adapter.execute({
      connector: plan.connector,
      target: plan.target,
      operation: plan.operation,
      mode: plan.mode,
      payloadRef,
      secretRefs,
      expectedVersion: plan.expectedVersion,
      idempotencyKey: plan.idempotencyKey,
      claimRef,
      correlationId,
      causationId
    });
  } catch (error) {
    raw = {
      status: error?.code === "TIMEOUT" || error?.code === "ETIMEDOUT" ? "TIMEOUT_UNKNOWN" : "STEP_FAILED",
      errorCode: error?.code ?? "ADAPTER_ERROR",
      errorMessage: error?.message ?? "adapter execution failed"
    };
  }

  assertReferenceOnly(raw);
  const normalized = normalizeConnectorObservation(raw);
  const versionBefore = raw?.providerVersionBefore ?? raw?.versionBefore ?? null;
  const versionAfter = raw?.providerVersionAfter ?? raw?.versionAfter ?? null;
  const versionConflict = Boolean(plan.expectedVersion && versionBefore && plan.expectedVersion !== versionBefore);
  const normalizedStatus = versionConflict ? "CONFLICT" : normalized.normalizedStatus;
  const completedAt = new Date().toISOString();

  const receipt = {
    schema: "road-connector-result-v1",
    operationId: raw?.operationId ?? `operation_${randomUUID()}`,
    planId: plan.planId,
    planHash: plan.planHash,
    connector: plan.connector,
    target: plan.target,
    resourceKey: plan.resourceKey,
    operation: plan.operation,
    agentId: plan.agentId,
    sessionId: plan.sessionId,
    claimRef,
    idempotencyKey: plan.idempotencyKey,
    expectedVersion: plan.expectedVersion,
    providerVersionBefore: versionBefore,
    providerVersionAfter: versionAfter,
    normalizedStatus,
    providerStatus: raw?.status ?? null,
    evidenceRefs: raw?.evidenceRefs ?? [],
    correlationId,
    causationId,
    startedAt,
    observedAt: completedAt,
    retrySafe: normalizedStatus === "EMPTY_OBSERVATION" || normalizedStatus === "STEP_SUCCEEDED",
    requiresReconciliation: normalizedStatus === "TIMEOUT_UNKNOWN",
    claimMayClose: !["TIMEOUT_UNKNOWN", "CONFLICT"].includes(normalizedStatus),
    secretRefs: [...secretRefs],
    secretValuesPersisted: false,
    receiptHash: null
  };
  receipt.receiptHash = digest({ ...receipt, receiptHash: null });
  return receipt;
}

export async function runWorkflowPlan({
  workflow,
  adapters,
  acquireClaim = async () => null,
  completeClaim = async () => null,
  onReceipt = async () => undefined
}) {
  if (!workflow?.canExecute) throw Object.assign(new Error("workflow_plan_blocked"), { code: "WORKFLOW_BLOCKED", blockedSteps: workflow?.blockedSteps ?? [] });
  const receipts = [];
  const receiptByStep = new Map();

  for (const wave of workflow.waves) {
    const waveReceipts = await Promise.all(wave.map(async (stepId) => {
      const step = workflow.steps.find((candidate) => candidate.id === stepId);
      if (!step) throw Object.assign(new Error(`workflow_step_missing:${stepId}`), { code: "INVALID_WORKFLOW" });
      const plan = step.dispatchPlan;
      const dependencies = step.dependsOn ?? [];
      const failedDependency = dependencies.find((dependency) => {
        const receipt = receiptByStep.get(dependency);
        return receipt && !["STEP_SUCCEEDED", "EMPTY_OBSERVATION"].includes(receipt.normalizedStatus);
      });
      if (failedDependency) {
        return {
          schema: "road-connector-result-v1",
          operationId: `operation_${randomUUID()}`,
          connector: plan.connector,
          target: plan.target,
          normalizedStatus: "CANCELLED",
          reason: `dependency_not_successful:${failedDependency}`,
          observedAt: new Date().toISOString(),
          secretValuesPersisted: false
        };
      }

      const claimRef = plan.claimRequired ? await acquireClaim(plan) : null;
      const receipt = await executeDispatchPlan({
        plan,
        adapters,
        claimRef,
        payloadRef: step.payloadRef ?? null,
        secretRefs: step.secretRefs ?? [],
        correlationId: workflow.correlationId,
        causationId: dependencies.length ? receiptByStep.get(dependencies.at(-1))?.receiptHash ?? null : null
      });
      if (claimRef && receipt.claimMayClose) await completeClaim(plan, claimRef, receipt);
      await onReceipt(step, receipt);
      return receipt;
    }));

    for (let index = 0; index < wave.length; index += 1) {
      receiptByStep.set(wave[index], waveReceipts[index]);
      receipts.push({ stepId: wave[index], receipt: waveReceipts[index] });
    }

    if (waveReceipts.some((receipt) => !["STEP_SUCCEEDED", "EMPTY_OBSERVATION"].includes(receipt.normalizedStatus))) break;
  }

  const complete = receipts.length === workflow.steps.length && receipts.every(({ receipt }) => ["STEP_SUCCEEDED", "EMPTY_OBSERVATION"].includes(receipt.normalizedStatus));
  return {
    schema: "road-connector-workflow-receipt-v1",
    workflowId: workflow.workflowId,
    correlationId: workflow.correlationId,
    complete,
    state: complete ? "SUCCEEDED" : "INCOMPLETE_OR_BLOCKED",
    receipts,
    completedAt: new Date().toISOString(),
    secretValuesPersisted: false
  };
}
