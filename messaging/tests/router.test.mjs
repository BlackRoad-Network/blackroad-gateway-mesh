import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSubscription,
  createEmptyRouterState,
  inboxForAgent,
  publicRouterStatus,
  registerSubscription,
  routeMessage,
  transitionInboxItem,
} from '../router.mjs';

const subscriptionInput = {
  agentId: 'agent-instance-4',
  sessionRef: 'session-agent4-a',
  providerIds: ['github'],
  mentionRefs: ['road://agent/agent-instance-4'],
  kinds: ['review'],
  deliveryMode: 'HANDOFF',
};

const messageInput = {
  messageId: 'road://message/github/abc',
  threadResource: 'road+message://github/repository/o/r/pr/4',
  providerId: 'github',
  providerMessageRef: 'comment-1',
  sourceReceiptRef: 'receipt:github:comment-1',
  sourceAgentId: 'connector-orchestrator',
  kind: 'review',
  actionRequired: true,
  mentionRefs: ['road://agent/agent-instance-4'],
  attachmentRefs: ['github:diff:4'],
  bodyRef: 'github:comment:comment-1/content',
  bodyHash: 'a'.repeat(64),
  summary: 'Review requires agent 4 attention',
};

test('router state starts empty', () => {
  assert.deepEqual(createEmptyRouterState().subscriptions, []);
});

test('subscription requires exact runtime session', () => {
  assert.throws(
    () => registerSubscription(createEmptyRouterState(), { ...subscriptionInput, sessionRef: null }),
    (error) => error.code === 'SESSION_REF_REQUIRED',
  );
});

test('subscription requires a bounded filter', () => {
  assert.throws(
    () => registerSubscription(createEmptyRouterState(), {
      agentId: 'agent-instance-4',
      sessionRef: 's',
      deliveryMode: 'INBOX',
    }),
    (error) => error.code === 'SUBSCRIPTION_FILTER_REQUIRED',
  );
});

test('semantic duplicate subscription replays', () => {
  const first = registerSubscription(createEmptyRouterState(), subscriptionInput, { now: '2026-09-02T16:00:00Z' });
  const second = registerSubscription(first.state, subscriptionInput, { now: '2026-09-02T16:00:01Z' });
  assert.equal(second.replay, true);
  assert.equal(second.state.subscriptions.length, 1);
});

test('matching message creates addressed inbox item and handoff plan', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput, { now: '2026-09-02T16:00:00Z' });
  const routed = routeMessage(registered.state, messageInput, { now: '2026-09-02T16:00:01Z' });
  assert.equal(routed.delivered, 1);
  assert.equal(routed.inboxItems[0].agentId, 'agent-instance-4');
  assert.equal(routed.inboxItems[0].state, 'ACTION_REQUIRED');
  assert.equal(routed.handoffPlans[0].toAgentId, 'agent-instance-4');
  assert.equal(routed.handoffPlans[0].requestedAction, 'review-and-act');
});

test('nonmatching provider does not deliver', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput, { now: '2026-09-02T16:00:00Z' });
  const routed = routeMessage(registered.state, { ...messageInput, providerId: 'slack' });
  assert.equal(routed.delivered, 0);
  assert.equal(routed.state.inbox.length, 0);
});

test('duplicate provider delivery does not duplicate inbox item', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput, { now: '2026-09-02T16:00:00Z' });
  const first = routeMessage(registered.state, messageInput, { now: '2026-09-02T16:00:01Z' });
  const second = routeMessage(first.state, messageInput, { now: '2026-09-02T16:00:02Z' });
  assert.equal(second.delivered, 0);
  assert.equal(second.state.inbox.length, 1);
  assert.equal(second.state.deliveries.length, 1);
});

test('only addressed agent may transition inbox state', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput);
  const routed = routeMessage(registered.state, messageInput);
  assert.throws(
    () => transitionInboxItem(routed.state, {
      agentId: 'agent-instance-2',
      sessionRef: 'session-agent4-a',
      inboxItemId: routed.inboxItems[0].id,
      state: 'SEEN',
    }),
    (error) => error.code === 'INBOX_RECIPIENT_MISMATCH',
  );
});

test('another session of same agent cannot inherit inbox authority', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput);
  const routed = routeMessage(registered.state, messageInput);
  assert.throws(
    () => transitionInboxItem(routed.state, {
      agentId: 'agent-instance-4',
      sessionRef: 'session-agent4-b',
      inboxItemId: routed.inboxItems[0].id,
      state: 'SEEN',
    }),
    (error) => error.code === 'INBOX_SESSION_MISMATCH',
  );
});

test('acknowledging inbox item never grants provider authority', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput);
  const routed = routeMessage(registered.state, messageInput);
  const transitioned = transitionInboxItem(routed.state, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    inboxItemId: routed.inboxItems[0].id,
    state: 'ACKNOWLEDGED',
  });
  assert.equal(transitioned.item.state, 'ACKNOWLEDGED');
  assert.equal(transitioned.authorityGranted, false);
  assert.equal(transitioned.satisfiesUserApproval, false);
  assert.equal(transitioned.satisfiesGovernance, false);
});

test('agent inbox sorts action-required high priority first', () => {
  const firstSub = registerSubscription(createEmptyRouterState(), {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    providerIds: ['github'],
    deliveryMode: 'INBOX',
  });
  const normal = routeMessage(firstSub.state, {
    ...messageInput,
    messageId: 'road://message/github/normal',
    providerMessageRef: 'normal',
    mentionRefs: [],
    kind: 'discussion',
    actionRequired: false,
  }, { now: '2026-09-02T16:00:01Z' });
  const high = routeMessage(normal.state, {
    ...messageInput,
    messageId: 'road://message/github/high',
    providerMessageRef: 'high',
    mentionRefs: [],
    kind: 'discussion',
    actionRequired: true,
  }, { now: '2026-09-02T16:00:02Z' });
  const inbox = inboxForAgent(high.state, 'agent-instance-4');
  assert.equal(inbox[0].priority, 'HIGH');
  assert.equal(inbox[0].state, 'ACTION_REQUIRED');
});

test('subscription can only be closed by its exact owning session', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput);
  assert.throws(
    () => closeSubscription(registered.state, {
      agentId: 'agent-instance-4',
      sessionRef: 'other-session',
      subscriptionId: registered.subscription.id,
    }),
    (error) => error.code === 'SUBSCRIPTION_OWNER_MISMATCH',
  );
  const closed = closeSubscription(registered.state, {
    agentId: 'agent-instance-4',
    sessionRef: 'session-agent4-a',
    subscriptionId: registered.subscription.id,
  });
  assert.equal(closed.subscription.state, 'CLOSED');
});

test('public router status exposes aggregates only', () => {
  const registered = registerSubscription(createEmptyRouterState(), subscriptionInput);
  const routed = routeMessage(registered.state, messageInput);
  const status = publicRouterStatus(routed.state);
  assert.equal(status.subscriptions, 1);
  assert.equal(status.actionRequired, 1);
  assert.equal(Object.hasOwn(status, 'threadResource'), false);
  assert.equal(Object.hasOwn(status, 'bodyRef'), false);
});
