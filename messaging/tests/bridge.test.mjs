import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMessagingInvocation, finishMessagingInvocation } from '../collaboration-bridge.mjs';
import { providerArguments } from '../provider-args.mjs';

const writeBase = {
  agentId: 'agent-instance-4',
  sessionRef: 'session-agent4-messaging',
  targetOwnerAgent: 'agent-instance-4',
  idempotencyKey: 'message-write-bridge-1',
  userApprovalRef: 'user-approval:current-request',
};

test('builds exact Slack threaded reply arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    body: 'hello',
  }), {
    channel_id: 'C1',
    thread_ts: '1234567890.123456',
    message: 'hello',
  });
});

test('builds exact GitHub PR comment arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'github',
    operation: 'createThread',
    target: { owner: 'BlackRoad-Network', repo: 'gateway', kind: 'pr', number: 4 },
    body: 'review context',
  }), {
    repo_full_name: 'BlackRoad-Network/gateway',
    pr_number: 4,
    comment: 'review context',
  });
});

test('builds exact Linear parent comment arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'linear',
    operation: 'createThread',
    target: { entityType: 'issue', entityId: 'LIN-42' },
    body: 'context',
  }), {
    issueId: 'LIN-42',
    body: 'context',
  });
});

test('builds exact Asana task comment arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'asana',
    operation: 'createThread',
    target: { taskId: '123' },
    body: 'context',
  }), {
    task_id: '123',
    text: 'context',
  });
});

test('builds exact Notion discussion reply arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'notion',
    operation: 'reply',
    target: { pageId: 'page-1', discussionId: 'discussion://page-1/block-1/thread-1' },
    body: 'reply',
  }), {
    page_id: 'page-1',
    discussion_id: 'discussion://page-1/block-1/thread-1',
    markdown: 'reply',
  });
});

test('builds exact Airtable threaded reply arguments', () => {
  assert.deepEqual(providerArguments({
    providerId: 'airtable',
    operation: 'reply',
    target: { baseId: 'app123', tableId: 'tbl123', recordId: 'rec123', parentCommentId: 'com123' },
    body: 'reply',
  }), {
    baseId: 'app123',
    tableId: 'tbl123',
    recordId: 'rec123',
    parentCommentId: 'com123',
    text: 'reply',
  });
});

test('builds Teams Chat SDK adapter descriptor without claiming authentication', () => {
  const args = providerArguments({
    providerId: 'microsoft-teams',
    operation: 'reply',
    target: { scope: 'tenant-a', threadId: 'thread-1' },
    body: 'reply',
  });
  assert.equal(args.adapter, '@chat-adapter/teams');
  assert.equal(args.method, 'thread.post');
  assert.equal(args.content, 'reply');
});

test('communicate operation emits intent, claim, and invocation commands', () => {
  const prepared = prepareMessagingInvocation({
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    body: 'hello',
    ...writeBase,
  });
  assert.equal(prepared.state, 'READY');
  assert.equal(prepared.mayCallProvider, true);
  assert.deepEqual(prepared.collaborationCommands.map((item) => item.type), [
    'intent.create',
    'claim.acquire',
    'invocation.start',
  ]);
  assert.equal(prepared.providerInvocation.tool, 'slack_send_message');
});

test('read operation does not request an exclusive mutation claim', () => {
  const prepared = prepareMessagingInvocation({
    providerId: 'github',
    operation: 'readThread',
    target: { owner: 'o', repo: 'r', number: 1 },
  });
  assert.equal(prepared.state, 'READY');
  assert.equal(prepared.plan.actionClass, 'READ');
  assert.equal(prepared.collaborationCommands.some((item) => item.type === 'claim.acquire'), false);
});

test('blocked operation cannot invoke provider', () => {
  const prepared = prepareMessagingInvocation({
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1234567890.123456' },
    body: 'hello',
    ...writeBase,
    userApprovalRef: null,
  });
  assert.equal(prepared.state, 'BLOCKED');
  assert.equal(prepared.mayCallProvider, false);
  assert.equal(prepared.providerInvocation, null);
  assert.deepEqual(prepared.collaborationCommands, []);
});

test('timeout retains claim and creates no success receipt', () => {
  const finished = finishMessagingInvocation({
    operationId: 'op-timeout',
    intentId: 'intent-timeout',
    invocationId: 'invoke-timeout',
    claimId: 'claim-timeout',
    providerId: 'slack',
    resourceKey: 'road+message://slack/team/T/channel/C/thread/1',
    agentId: 'agent-instance-4',
    sessionRef: 'session-4',
    actionClass: 'COMMUNICATE',
    kind: 'timeout',
  });
  assert.equal(finished.state, 'TIMEOUT_UNKNOWN');
  assert.equal(finished.holdClaim, true);
  assert.equal(finished.releaseClaim, false);
  assert.equal(finished.receipt, null);
});

test('provider acknowledgement requires read-back before receipt', () => {
  const finished = finishMessagingInvocation({
    operationId: 'op-success',
    intentId: 'intent-success',
    invocationId: 'invoke-success',
    claimId: 'claim-success',
    providerId: 'github',
    resourceKey: 'road+message://github/repository/o/r/pr/1',
    agentId: 'agent-instance-4',
    sessionRef: 'session-4',
    actionClass: 'COMMUNICATE',
    kind: 'success',
    verificationMatched: false,
  });
  assert.equal(finished.state, 'VERIFYING');
  assert.equal(finished.receipt, null);
  assert.ok(finished.collaborationCommands.some((item) => item.type === 'verification.required'));
});

test('verified provider mutation creates receipt and releases claim', () => {
  const finished = finishMessagingInvocation({
    operationId: 'op-verified',
    intentId: 'intent-verified',
    invocationId: 'invoke-verified',
    claimId: 'claim-verified',
    providerId: 'slack',
    resourceKey: 'road+message://slack/team/T/channel/C/thread/1',
    agentId: 'agent-instance-4',
    sessionRef: 'session-4',
    actionClass: 'COMMUNICATE',
    kind: 'success',
    verificationMatched: true,
    verificationRef: 'slack:thread:readback:1',
    providerRequestRef: 'slack:message:1',
    idempotencyKey: 'idem-1',
    bodyHash: 'a'.repeat(64),
  });
  assert.equal(finished.state, 'VERIFIED');
  assert.equal(finished.releaseClaim, true);
  assert.equal(finished.receipt.secretValuesPersisted, false);
  assert.equal(finished.receipt.bodyPersisted, false);
  assert.ok(finished.collaborationCommands.some((item) => item.type === 'receipt.record'));
  assert.ok(finished.collaborationCommands.some((item) => item.type === 'claim.release'));
});
