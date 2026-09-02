import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DOCUMENT,
  MessagingError,
  canonicalThreadResource,
  classifyOutcome,
  normalizeInboundMessage,
  operationCapability,
  planMirror,
  planOperation,
  planReceipt,
  providerSnapshot,
  reactionMeaning,
} from '../framework.mjs';
import { TOOL_DEFINITIONS, callTool } from '../mcp-server.mjs';

const writeBase = {
  agentId: 'agent-instance-4',
  sessionRef: 'session-4-a',
  targetOwnerAgent: 'agent-instance-4',
  idempotencyKey: 'message-write-1',
  userApprovalRef: 'user-approval:current-request',
};

test('registry has twelve reviewed providers', () => {
  assert.equal(PROVIDER_DOCUMENT.providers.length, 12);
});

test('provider ids are unique', () => {
  assert.equal(new Set(PROVIDER_DOCUMENT.providers.map((provider) => provider.id)).size, 12);
});

test('six native messaging connectors are connected', () => {
  assert.equal(PROVIDER_DOCUMENT.providers.filter((provider) => provider.status === 'CONNECTED').length, 6);
});

test('Teams is represented as adapter available but not authenticated', () => {
  const teams = PROVIDER_DOCUMENT.providers.find((provider) => provider.id === 'microsoft-teams');
  assert.equal(teams.status, 'ADAPTER_AVAILABLE_CONFIG_REQUIRED');
  assert.equal(teams.adapter, '@chat-adapter/teams');
});

test('provider snapshot omits provider payloads and secrets', () => {
  const snapshot = providerSnapshot();
  assert.equal(snapshot.length, 12);
  assert.equal(Object.hasOwn(snapshot[0], 'token'), false);
});

test('Slack reply plans exact native thread tool', () => {
  const plan = planOperation({
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '123.456' },
    body: 'hello',
    ...writeBase,
  });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.tool, 'slack_send_message');
  assert.equal(plan.actionClass, 'COMMUNICATE');
  assert.equal(plan.verification.required, true);
});

test('Slack edits require explicit approval evidence', () => {
  const plan = planOperation({
    providerId: 'slack',
    operation: 'edit',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '123.456' },
    body: 'edit',
    ...writeBase,
    userApprovalRef: null,
  });
  assert.equal(plan.state, 'BLOCKED');
  assert.ok(plan.blockers.includes('userApprovalRef-required-for-COMMUNICATE'));
});

test('GitHub top-level PR comments plan add_comment_to_issue', () => {
  const plan = planOperation({
    providerId: 'github',
    operation: 'createThread',
    target: { owner: 'BlackRoad-Network', repo: 'Repo', kind: 'pr', number: 9 },
    body: 'review',
    ...writeBase,
  });
  assert.equal(plan.tool, 'add_comment_to_issue');
  assert.match(plan.resourceKey, /blackroad-network\/repo\/pr\/9$/);
});

test('GitHub inline review replies use review reply tool', () => {
  const plan = planOperation({
    providerId: 'github',
    operation: 'reviewReply',
    target: { owner: 'o', repo: 'r', kind: 'pr', number: 1 },
    body: 'reply',
    ...writeBase,
  });
  assert.equal(plan.tool, 'reply_to_review_comment');
});

test('Linear replies use parent comments', () => {
  const plan = planOperation({
    providerId: 'linear',
    operation: 'reply',
    target: { entityType: 'issue', entityId: 'LIN-42' },
    body: 'reply',
    ...writeBase,
  });
  assert.equal(plan.tool, 'save_comment');
  assert.ok(plan.requiredArguments.includes('parentId'));
});

test('Asana nested reply is explicitly unsupported', () => {
  const plan = planOperation({
    providerId: 'asana',
    operation: 'reply',
    target: { taskId: '123' },
    ...writeBase,
  });
  assert.equal(plan.state, 'UNSUPPORTED');
});

test('Notion discussion reply has page and discussion ids', () => {
  const capability = operationCapability('notion', 'reply');
  assert.equal(capability.supported, true);
  assert.deepEqual(capability.spec.required.slice(0, 2), ['page_id', 'discussion_id']);
});

test('Airtable reply preserves parentCommentId requirement', () => {
  const capability = operationCapability('airtable', 'reply');
  assert.ok(capability.spec.required.includes('parentCommentId'));
});

test('mutations require live runtime session', () => {
  const plan = planOperation({
    providerId: 'slack',
    operation: 'reply',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1.1' },
    body: 'x',
    ...writeBase,
    sessionRef: null,
  });
  assert.ok(plan.blockers.includes('sessionRef-required'));
});

test('reads do not require user approval', () => {
  const plan = planOperation({
    providerId: 'slack',
    operation: 'readThread',
    target: { teamId: 'T1', channelId: 'C1', threadTs: '1.1' },
  });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.actionClass, 'READ');
});

test('canonical GitHub thread identity normalizes case', () => {
  const first = canonicalThreadResource('github', {
    owner: 'BlackRoad-Network', repo: 'Gateway', kind: 'PR', number: 2,
  });
  const second = canonicalThreadResource('github', {
    owner: 'blackroad-network', repo: 'gateway', kind: 'pr', number: '2',
  });
  assert.equal(first, second);
});

test('mirror planner blocks loops', () => {
  const plan = planMirror({
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', number: 1 },
    destinationTarget: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
    sourceState: 'VERIFIED',
    userApprovalRef: 'approval',
    lineage: ['slack'],
    body: 'x',
  });
  assert.ok(plan.blockers.includes('mirror-loop-detected'));
});

test('mirror planner requires verified source', () => {
  const plan = planMirror({
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', number: 1 },
    destinationTarget: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
    sourceState: 'SUCCEEDED_UNVERIFIED',
    userApprovalRef: 'approval',
    body: 'x',
  });
  assert.ok(plan.blockers.includes('source-message-not-verified'));
});

test('mirror planner disables bidirectional mode', () => {
  const plan = planMirror({
    sourceProviderId: 'github',
    destinationProviderId: 'slack',
    sourceTarget: { owner: 'o', repo: 'r', number: 1 },
    destinationTarget: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
    sourceState: 'VERIFIED',
    userApprovalRef: 'approval',
    bidirectional: true,
    body: 'x',
  });
  assert.ok(plan.blockers.includes('bidirectional-mirroring-disabled-by-default'));
});

test('provider success on a mutation enters VERIFYING', () => {
  assert.equal(classifyOutcome({ kind: 'success', mutating: true }).state, 'VERIFYING');
});

test('read-back match upgrades mutation to VERIFIED', () => {
  assert.equal(classifyOutcome({ kind: 'success', mutating: true, verificationMatched: true }).state, 'VERIFIED');
});

test('timeout remains TIMEOUT_UNKNOWN and is not retried blindly', () => {
  const outcome = classifyOutcome({ kind: 'timeout', mutating: true });
  assert.equal(outcome.state, 'TIMEOUT_UNKNOWN');
  assert.equal(outcome.retryAllowed, false);
});

test('successful zero-result read remains EMPTY_OBSERVATION', () => {
  assert.equal(classifyOutcome({ kind: 'success', count: 0 }).state, 'EMPTY_OBSERVATION');
});

test('reaction acknowledgement never grants authority', () => {
  const result = reactionMeaning('white_check_mark');
  assert.equal(result.meaning, 'ACKNOWLEDGED');
  assert.equal(result.grantsAuthority, false);
  assert.equal(result.satisfiesUserApproval, false);
});

test('receipt rejects unverified communicate success', () => {
  assert.throws(
    () => planReceipt({ actionClass: 'COMMUNICATE', outcomeState: 'SUCCEEDED' }),
    (error) => error instanceof MessagingError && error.code === 'UNVERIFIED_MUTATION_RECEIPT',
  );
});

test('receipt accepts verified communicate result with read-back', () => {
  const receipt = planReceipt({
    operationId: 'op1',
    providerId: 'slack',
    resourceKey: 'road+message://slack/x',
    agentId: 'agent-instance-4',
    sessionRef: 's',
    actionClass: 'COMMUNICATE',
    outcomeState: 'VERIFIED',
    verificationRef: 'slack:message:readback',
    bodyHash: 'a'.repeat(64),
  });
  assert.equal(receipt.secretValuesPersisted, false);
  assert.equal(receipt.bodyPersisted, false);
});

test('durable inbound message record stores body reference and hash, not body', () => {
  const normalized = normalizeInboundMessage({
    providerId: 'slack',
    target: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
    providerMessageRef: '1.2',
    body: 'hello',
  });
  assert.equal(Object.hasOwn(normalized.durable, 'body'), false);
  assert.equal(normalized.transient.body, 'hello');
  assert.equal(normalized.durable.bodyLength, 5);
});

test('outbound private key material is rejected', () => {
  assert.throws(
    () => planOperation({
      providerId: 'slack',
      operation: 'reply',
      target: { teamId: 'T', channelId: 'C', threadTs: '1.1' },
      body: '-----BEGIN OPENSSH PRIVATE KEY-----',
      ...writeBase,
    }),
    (error) => error.code === 'SECRET_MATERIAL_REJECTED',
  );
});

test('MCP exposes thirteen planner tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 13);
});

test('MCP read planner executes without provider side effects', () => {
  const output = callTool('messaging_thread_read_plan', {
    providerId: 'github',
    target: { owner: 'o', repo: 'r', number: 1 },
  });
  assert.equal(output.structuredContent.actionClass, 'READ');
});
