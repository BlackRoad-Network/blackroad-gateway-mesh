import {
  classifyOutcome,
  planOperation,
  planReceipt,
  sha256,
  stableStringify,
} from './framework.mjs';
import { providerArguments } from './provider-args.mjs';

function operationIdFor(input, plan) {
  if (input.operationId) return String(input.operationId);
  const identity = {
    providerId: plan.providerId,
    operation: plan.operation,
    resourceKey: plan.resourceKey,
    idempotencyKey: input.idempotencyKey || null,
    requestHash: plan.collaboration?.requestHash || null,
  };
  return `msgop_${sha256(stableStringify(identity)).slice(0, 24)}`;
}

function intentIdFor(operationId) {
  return `intent_${operationId}`;
}

function claimIdFor(operationId) {
  return `claim_${operationId}`;
}

function invocationIdFor(operationId) {
  return `invocation_${operationId}`;
}

export function prepareMessagingInvocation(input) {
  const plan = planOperation(input);
  const operationId = operationIdFor(input, plan);

  if (plan.state !== 'READY') {
    return {
      schema: 'road-messaging-invocation-preparation-v1',
      state: plan.state,
      operationId,
      plan,
      providerInvocation: null,
      collaborationCommands: [],
      mayCallProvider: false,
    };
  }

  const args = providerArguments(input);
  const providerRequestShape = {
    providerId: plan.providerId,
    tool: plan.tool,
    resourceKey: plan.resourceKey,
    argumentHash: sha256(stableStringify(args)),
  };
  const requestHash = sha256(stableStringify(providerRequestShape));

  const providerInvocation = {
    connectorId: plan.providerId,
    tool: plan.tool,
    arguments: args,
    requestHash,
    transient: true,
  };

  if (plan.actionClass === 'READ') {
    return {
      schema: 'road-messaging-invocation-preparation-v1',
      state: 'READY',
      operationId,
      plan,
      providerInvocation,
      collaborationCommands: [
        {
          type: 'observation.prepare',
          agentId: input.agentId || null,
          sessionRef: input.sessionRef || null,
          connectorId: plan.providerId,
          resourceKey: plan.resourceKey,
          requestHash,
        },
      ],
      mayCallProvider: true,
    };
  }

  const intentId = input.intentId || intentIdFor(operationId);
  const claimId = input.claimId || claimIdFor(operationId);
  const invocationId = input.invocationId || invocationIdFor(operationId);

  return {
    schema: 'road-messaging-invocation-preparation-v1',
    state: 'READY',
    operationId,
    intentId,
    claimId,
    invocationId,
    plan,
    providerInvocation,
    collaborationCommands: [
      {
        type: 'intent.create',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        connectorId: plan.providerId,
        intentId,
        resourceKey: plan.resourceKey,
        actionClass: 'COMMUNICATE',
        targetOwnerAgent: input.targetOwnerAgent,
        idempotencyKey: input.idempotencyKey,
        expectedResourceVersionRef: input.expectedResourceVersionRef || null,
        decisionReceiptRef: input.governanceRef || null,
        userApprovalRef: input.userApprovalRef,
        requestHash,
      },
      {
        type: 'claim.acquire',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        connectorId: plan.providerId,
        intentId,
        claimId,
        resourceKey: plan.resourceKey,
        actionClass: 'COMMUNICATE',
        idempotencyKey: input.idempotencyKey,
        expectedResourceVersionRef: input.expectedResourceVersionRef || null,
      },
      {
        type: 'invocation.start',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        connectorId: plan.providerId,
        intentId,
        invocationId,
        claimId,
        resourceKey: plan.resourceKey,
        actionClass: 'COMMUNICATE',
        requestHash,
        toolName: plan.tool,
      },
    ],
    mayCallProvider: true,
  };
}

export function finishMessagingInvocation(input) {
  const outcome = classifyOutcome({
    kind: input.kind,
    mutating: input.actionClass === 'COMMUNICATE',
    count: input.count,
    verificationMatched: input.verificationMatched,
  });

  const base = {
    schema: 'road-messaging-invocation-finish-v1',
    operationId: input.operationId,
    intentId: input.intentId || null,
    invocationId: input.invocationId || null,
    claimId: input.claimId || null,
    state: outcome.state,
    outcome,
    collaborationCommands: [],
    receipt: null,
    releaseClaim: false,
  };

  if (outcome.state === 'TIMEOUT_UNKNOWN') {
    return {
      ...base,
      holdClaim: true,
      retryAllowed: false,
      next: 'provider-native-read-back-before-retry',
      collaborationCommands: [
        {
          type: 'invocation.finish',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
          state: 'TIMEOUT_UNKNOWN',
          providerRequestRef: input.providerRequestRef || null,
          responseHash: input.responseHash || null,
        },
      ],
    };
  }

  if (outcome.state === 'VERIFYING') {
    return {
      ...base,
      holdClaim: true,
      next: 'provider-native-read-after-write',
      collaborationCommands: [
        {
          type: 'invocation.finish',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
          state: 'VERIFYING',
          providerRequestRef: input.providerRequestRef || null,
          responseHash: input.responseHash || null,
        },
        {
          type: 'verification.required',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
        },
      ],
    };
  }

  if (outcome.state === 'VERIFIED') {
    const receipt = planReceipt({
      operationId: input.operationId,
      providerId: input.providerId,
      resourceKey: input.resourceKey,
      agentId: input.agentId,
      sessionRef: input.sessionRef,
      actionClass: input.actionClass,
      outcomeState: 'VERIFIED',
      providerRequestRef: input.providerRequestRef || null,
      verificationRef: input.verificationRef,
      idempotencyKey: input.idempotencyKey || null,
      bodyHash: input.bodyHash || null,
      recordedAt: input.recordedAt,
    });

    return {
      ...base,
      receipt,
      releaseClaim: true,
      holdClaim: false,
      collaborationCommands: [
        {
          type: 'invocation.finish',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
          state: 'PROVIDER_ACKNOWLEDGED',
          providerRequestRef: input.providerRequestRef || null,
          responseHash: input.responseHash || null,
        },
        {
          type: 'verification.record',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
          observedResourceVersionRef: input.observedResourceVersionRef || null,
          evidenceRef: input.verificationRef,
          state: 'VERIFIED',
        },
        {
          type: 'receipt.record',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
          receipt,
        },
        {
          type: 'claim.release',
          agentId: input.agentId,
          sessionRef: input.sessionRef,
          connectorId: input.providerId,
          intentId: input.intentId || null,
          invocationId: input.invocationId || null,
          claimId: input.claimId || null,
          resourceKey: input.resourceKey,
          actionClass: input.actionClass,
        },
      ],
    };
  }

  const receipt = planReceipt({
    operationId: input.operationId,
    providerId: input.providerId,
    resourceKey: input.resourceKey,
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    actionClass: input.actionClass,
    outcomeState: outcome.state,
    providerRequestRef: input.providerRequestRef || null,
    idempotencyKey: input.idempotencyKey || null,
    bodyHash: input.bodyHash || null,
    recordedAt: input.recordedAt,
  });

  return {
    ...base,
    receipt,
    releaseClaim: input.actionClass === 'COMMUNICATE',
    collaborationCommands: [
      {
        type: 'invocation.finish',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        connectorId: input.providerId,
        intentId: input.intentId || null,
        invocationId: input.invocationId || null,
        claimId: input.claimId || null,
        resourceKey: input.resourceKey,
        actionClass: input.actionClass,
        state: outcome.state,
        providerRequestRef: input.providerRequestRef || null,
        responseHash: input.responseHash || null,
      },
      {
        type: 'receipt.record',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        connectorId: input.providerId,
        intentId: input.intentId || null,
        invocationId: input.invocationId || null,
        claimId: input.claimId || null,
        resourceKey: input.resourceKey,
        actionClass: input.actionClass,
        receipt,
      },
      ...(input.actionClass === 'COMMUNICATE'
        ? [{
            type: 'claim.release',
            agentId: input.agentId,
            sessionRef: input.sessionRef,
            connectorId: input.providerId,
            intentId: input.intentId || null,
            invocationId: input.invocationId || null,
            claimId: input.claimId || null,
            resourceKey: input.resourceKey,
            actionClass: input.actionClass,
          }]
        : []),
    ],
  };
}
