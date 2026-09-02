import { randomUUID, createHash } from "node:crypto";
import { planDispatch } from "./dispatch.mjs";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeSteps(input) {
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw Object.assign(new Error("workflow_steps_required"), { code: "INVALID_WORKFLOW" });
  }
  const ids = new Set();
  return input.steps.map((step, index) => {
    const id = step.id ?? `step-${index + 1}`;
    if (ids.has(id)) throw Object.assign(new Error(`duplicate_step_id:${id}`), { code: "INVALID_WORKFLOW" });
    ids.add(id);
    return { ...step, id, dependsOn: [...new Set(step.dependsOn ?? [])] };
  });
}

function assertReferences(steps) {
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw Object.assign(new Error(`unknown_dependency:${step.id}:${dependency}`), { code: "INVALID_WORKFLOW" });
      if (dependency === step.id) throw Object.assign(new Error(`self_dependency:${step.id}`), { code: "INVALID_WORKFLOW" });
    }
  }
}

function topologicalWaves(steps) {
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const done = new Set();
  const waves = [];
  while (remaining.size) {
    const wave = [...remaining.entries()]
      .filter(([, dependencies]) => [...dependencies].every((dependency) => done.has(dependency)))
      .map(([id]) => id)
      .sort();
    if (!wave.length) throw Object.assign(new Error("workflow_cycle_detected"), { code: "WORKFLOW_CYCLE" });
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      done.add(id);
    }
  }
  return waves;
}

function serializeSameResource(steps, plans) {
  const lastMutation = new Map();
  const inferred = [];
  for (const step of steps) {
    const plan = plans.get(step.id);
    if (!plan?.mutating) continue;
    const previous = lastMutation.get(plan.resourceKey);
    if (previous && !step.dependsOn.includes(previous)) {
      step.dependsOn.push(previous);
      inferred.push({
        from: previous,
        to: step.id,
        reason: "same_connector_resource_serialization",
        resourceKey: plan.resourceKey
      });
    }
    lastMutation.set(plan.resourceKey, step.id);
  }
  return inferred;
}

export async function planWorkflow(input, overrides = {}) {
  const workflowId = input.workflowId ?? `workflow_${randomUUID()}`;
  const steps = normalizeSteps(input);
  assertReferences(steps);

  const plans = new Map();
  for (const step of steps) {
    plans.set(step.id, await planDispatch({
      ...step,
      agentId: step.agentId ?? input.agentId,
      sessionId: step.sessionId ?? input.sessionId
    }, overrides));
  }

  const inferredDependencies = serializeSameResource(steps, plans);
  assertReferences(steps);
  const waves = topologicalWaves(steps);
  const handoffs = [];

  for (const step of steps) {
    const plan = plans.get(step.id);
    if (plan.handoffRequired) {
      handoffs.push({
        id: `handoff_${randomUUID()}`,
        fromAgent: plan.agentId,
        toAgent: plan.domainOwner,
        stepId: step.id,
        kind: "connector-operation-delegation",
        connector: plan.connector,
        target: plan.target,
        requiredBeforeDispatch: true
      });
    }
  }

  const blockedSteps = [...plans.entries()]
    .filter(([, plan]) => !plan.canDispatch)
    .map(([stepId, plan]) => ({ stepId, blockedBy: plan.blockedBy }));

  const output = {
    schema: "road-connector-workflow-plan-v1",
    workflowId,
    createdAt: new Date().toISOString(),
    requestedBy: input.agentId,
    correlationId: input.correlationId ?? `corr_${randomUUID()}`,
    steps: steps.map((step) => ({ ...step, dispatchPlan: plans.get(step.id) })),
    waves,
    inferredDependencies,
    handoffs,
    blockedSteps,
    canExecute: blockedSteps.length === 0,
    completionRule: "all_steps_receipted_and_workflow_validation_passed",
    retryRule: "verify_provider_state_before_retrying_timeout_unknown"
  };
  output.planHash = hash({ ...output, createdAt: null, planHash: null });
  return output;
}

export const workflowInternals = {
  normalizeSteps,
  assertReferences,
  topologicalWaves,
  serializeSameResource
};
