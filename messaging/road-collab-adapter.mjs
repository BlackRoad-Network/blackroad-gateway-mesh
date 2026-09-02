import { MessagingError, sha256, stableStringify } from './framework.mjs';
import { claimOutboxItem, completeOutboxItem, pendingOutboxItems } from './outbox.mjs';

export function prepareRoadCollabHandoff(state, input, options = {}) {
  const claimed = claimOutboxItem(state, input, options);
  const item = claimed.item;
  const plan = item.plan;
  const requestHash = sha256(stableStringify({
    type: 'handoff.create',
    fromAgentId: plan.fromAgentId,
    toAgentId: plan.toAgentId,
    connectorId: plan.connectorId,
    resourceKey: plan.resourceKey,
    requestedAction: plan.requestedAction,
    artifactRefs: plan.artifactRefs,
    evidenceRefs: plan.evidenceRefs,
  }));

  return {
    state: claimed.state,
    outboxItem: item,
    replay: claimed.replay,
    mayCallBroker: true,
    broker: {
      service: 'road://service/collaboration',
      command: {
        type: 'handoff.create',
        agentId: input.agentId,
        sessionRef: input.sessionRef,
        fromAgentId: plan.fromAgentId,
        toAgentId: plan.toAgentId,
        connectorId: plan.connectorId,
        resourceKey: plan.resourceKey,
        summary: plan.summary,
        artifactRefs: plan.artifactRefs,
        evidenceRefs: plan.evidenceRefs,
        requestedAction: plan.requestedAction,
        idempotencyKey: `messaging-handoff:${item.semanticKey}`,
        requestHash,
      },
    },
  };
}

export function finishRoadCollabHandoff(state, input, options = {}) {
  if (input.kind === 'timeout') {
    return completeOutboxItem(state, {
      outboxId: input.outboxId,
      agentId: input.agentId,
      sessionRef: input.sessionRef,
      state: 'TIMEOUT_UNKNOWN',
      deliveryRef: input.providerRequestRef || input.brokerRequestRef || null,
    }, options);
  }

  if (input.kind === 'success') {
    if (!input.handoffRef || !input.verificationRef) {
      throw new MessagingError('HANDOFF_VERIFICATION_REQUIRED', 'Successful road-collab handoff delivery requires handoffRef and broker read-back verificationRef');
    }
    return completeOutboxItem(state, {
      outboxId: input.outboxId,
      agentId: input.agentId,
      sessionRef: input.sessionRef,
      state: 'DELIVERED',
      deliveryRef: input.handoffRef,
      resultRef: input.verificationRef,
    }, options);
  }

  if (input.kind === 'cancelled') {
    return completeOutboxItem(state, {
      outboxId: input.outboxId,
      agentId: input.agentId,
      sessionRef: input.sessionRef,
      state: 'CANCELLED',
      resultRef: input.resultRef || null,
    }, options);
  }

  return completeOutboxItem(state, {
    outboxId: input.outboxId,
    agentId: input.agentId,
    sessionRef: input.sessionRef,
    state: 'FAILED',
    resultRef: input.resultRef || null,
  }, options);
}

export function roadCollabDrainPlan(state, input = {}) {
  const limit = Math.max(1, Math.min(100, Number(input.limit || 20)));
  return pendingOutboxItems(state).slice(0, limit).map((item) => ({
    outboxId: item.id,
    targetAgentId: item.plan.toAgentId,
    connectorId: item.plan.connectorId,
    resourceKeyHash: sha256(item.plan.resourceKey),
    semanticKey: item.semanticKey,
    action: 'prepareRoadCollabHandoff',
    privatePlanExposed: false,
  }));
}
