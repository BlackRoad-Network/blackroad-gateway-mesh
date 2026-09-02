import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMention,
  planMentionedMessage,
  resolveInboundMention,
} from '../mentions.mjs';

const identityMap = {
  schema: 'road-messaging-identity-map-v1',
  identities: [
    {
      ref: 'road://human/alexa',
      label: 'Alexa',
      providers: {
        slack: { kind: 'user', id: 'U123' },
        github: { kind: 'user', handle: 'blackboxprogramming' },
        linear: { kind: 'user', displayName: 'Alexa Amundson' },
        airtable: { kind: 'user', id: 'usr123' },
        asana: { kind: 'user', gid: '1200123' },
        notion: { kind: 'user', id: 'notion-user-123' },
        'microsoft-teams': { kind: 'user', id: 'aad-user-123', displayName: 'Alexa' },
      },
    },
    {
      ref: 'road://team/engineering',
      label: 'Engineering',
      providers: {
        slack: { kind: 'user-group', id: 'S123', handle: 'engineering' },
      },
    },
  ],
};

test('formats Slack user mention', () => {
  assert.equal(formatMention('slack', 'road://human/alexa', identityMap), '<@U123>');
});

test('formats Slack user-group mention', () => {
  assert.equal(formatMention('slack', 'road://team/engineering', identityMap), '<!subteam^S123|@engineering>');
});

test('formats GitHub handle mention', () => {
  assert.equal(formatMention('github', 'road://human/alexa', identityMap), '@blackboxprogramming');
});

test('formats Airtable mention token', () => {
  assert.equal(formatMention('airtable', 'road://human/alexa', identityMap), '@[usr123]');
});

test('formats Asana mention anchor', () => {
  assert.equal(formatMention('asana', 'road://human/alexa', identityMap), '<a data-asana-gid="1200123"/>');
});

test('formats Notion rich-text mention object', () => {
  const mention = formatMention('notion', 'road://human/alexa', identityMap);
  assert.equal(mention.type, 'mention');
  assert.equal(mention.mention.user.id, 'notion-user-123');
});

test('formats Teams mention as adapter descriptor without inventing syntax', () => {
  const mention = formatMention('microsoft-teams', 'road://human/alexa', identityMap);
  assert.equal(mention.providerIdentity, 'aad-user-123');
  assert.equal(mention.mentionRef, 'road://human/alexa');
});

test('resolves inbound provider identity to canonical identity', () => {
  const result = resolveInboundMention('github', '@blackboxprogramming', identityMap);
  assert.equal(result.state, 'RESOLVED');
  assert.equal(result.mentionRef, 'road://human/alexa');
});

test('unmapped inbound identity remains unresolved', () => {
  const result = resolveInboundMention('slack', 'U999', identityMap);
  assert.equal(result.state, 'UNRESOLVED');
  assert.equal(result.mentionRef, null);
});

test('message plan blocks an unmapped canonical mention', () => {
  const plan = planMentionedMessage({
    providerId: 'slack',
    body: 'Please review.',
    mentionRefs: ['road://human/unknown'],
    identityMap,
  });
  assert.equal(plan.state, 'BLOCKED');
  assert.equal(plan.unresolved[0].reason, 'MENTION_IDENTITY_UNMAPPED');
});

test('message plan persists canonical refs but not rendered provider identities', () => {
  const plan = planMentionedMessage({
    providerId: 'slack',
    body: 'Please review.',
    mentionRefs: ['road://human/alexa'],
    identityMap,
  });
  assert.equal(plan.state, 'READY');
  assert.equal(plan.transientContent, '<@U123> Please review.');
  assert.equal(plan.persistence.storeCanonicalRefs, true);
  assert.equal(plan.persistence.storeProviderIdentityValues, false);
  assert.equal(plan.persistence.storeRenderedBody, false);
});
