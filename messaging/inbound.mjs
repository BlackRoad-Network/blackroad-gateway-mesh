import { MessagingError, canonicalThreadResource, sha256, stableStringify } from './framework.mjs';
import { verifyInboundWebhook } from './webhook-verification.mjs';

export const INBOUND_EVENT_TYPES = new Set([
  'MESSAGE_CREATED',
  'MESSAGE_UPDATED',
  'MESSAGE_DELETED',
  'MENTION_RECEIVED',
  'REACTION_ADDED',
  'REACTION_REMOVED',
  'THREAD_RESOLVED',
  'THREAD_REOPENED',
  'HANDSHAKE',
  'UNSUPPORTED_EVENT',
]);

function parseJsonBody(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  try {
    return { text, payload: JSON.parse(text) };
  } catch (error) {
    throw new MessagingError('WEBHOOK_JSON_INVALID', `Inbound webhook body is not valid JSON: ${error.message}`);
  }
}

function providerActor(providerId, value) {
  return value ? `${providerId}:actor:${String(value)}` : null;
}

function extractSlackMentionIds(text) {
  const source = String(text || '');
  const values = [];
  for (const match of source.matchAll(/<@([A-Z0-9]+)>/g)) values.push(match[1]);
  for (const match of source.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/g)) values.push(match[1]);
  return [...new Set(values)];
}

function slackTarget(payload, event, message = event) {
  const channelId = event.channel || event.item?.channel || message.channel;
  const messageTs = message.ts || event.item?.ts || event.deleted_ts || event.ts;
  const threadTs = message.thread_ts || event.previous_message?.thread_ts || messageTs;
  if (!payload.team_id || !channelId || !threadTs) {
    throw new MessagingError('INBOUND_TARGET_INCOMPLETE', 'Slack event lacks team, channel, or thread identity');
  }
  return {
    teamId: String(payload.team_id),
    channelId: String(channelId),
    threadTs: String(threadTs),
    messageTs: messageTs ? String(messageTs) : null,
  };
}

export function normalizeSlackPayload(payload, verification) {
  if (payload.type === 'url_verification') {
    return {
      schema: 'road-messaging-inbound-event-v1',
      eventId: payload.event_id || `slack-handshake-${verification.rawBodyHash.slice(0, 24)}`,
      providerId: 'slack',
      type: 'HANDSHAKE',
      verification,
      challengeRef: payload.challenge ? `slack:challenge:${sha256(payload.challenge).slice(0, 24)}` : null,
      rawBodyPersisted: false,
      bodyPersisted: false,
    };
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    return {
      schema: 'road-messaging-inbound-event-v1',
      eventId: payload.event_id || `slack-event-${verification.rawBodyHash.slice(0, 24)}`,
      providerId: 'slack',
      type: 'UNSUPPORTED_EVENT',
      providerEventType: payload.type || null,
      verification,
      rawBodyPersisted: false,
      bodyPersisted: false,
    };
  }

  const event = payload.event;
  let type = 'UNSUPPORTED_EVENT';
  let message = event;
  let providerMessageRef = event.ts || null;
  let parentProviderMessageRef = event.thread_ts || null;
  let body = event.text || '';
  let providerVersionRef = event.edited?.ts || event.ts || null;

  if (event.type === 'app_mention') type = 'MENTION_RECEIVED';
  else if (event.type === 'message' && event.subtype === 'message_changed') {
    type = 'MESSAGE_UPDATED';
    message = event.message || {};
    providerMessageRef = message.ts || event.ts || null;
    parentProviderMessageRef = message.thread_ts || null;
    body = message.text || '';
    providerVersionRef = message.edited?.ts || event.event_ts || message.ts || null;
  } else if (event.type === 'message' && event.subtype === 'message_deleted') {
    type = 'MESSAGE_DELETED';
    message = event.previous_message || {};
    providerMessageRef = event.deleted_ts || message.ts || null;
    parentProviderMessageRef = message.thread_ts || null;
    body = '';
    providerVersionRef = event.event_ts || event.ts || null;
  } else if (event.type === 'message' && !event.subtype) type = 'MESSAGE_CREATED';
  else if (event.type === 'reaction_added') {
    type = 'REACTION_ADDED';
    providerMessageRef = event.item?.ts || null;
    body = '';
  } else if (event.type === 'reaction_removed') {
    type = 'REACTION_REMOVED';
    providerMessageRef = event.item?.ts || null;
    body = '';
  }

  const target = slackTarget(payload, event, message);
  const threadResource = canonicalThreadResource('slack', target);
  const actorValue = event.user || event.item_user || message.user || event.bot_id || message.bot_id || null;
  const eventId = payload.event_id || `${event.type || 'unknown'}:${event.event_ts || event.ts || verification.rawBodyHash}`;

  return {
    schema: 'road-messaging-inbound-event-v1',
    eventId: String(eventId),
    providerId: 'slack',
    providerEventType: event.type || null,
    providerEventSubtype: event.subtype || null,
    type,
    target,
    threadResource,
    providerMessageRef: providerMessageRef ? String(providerMessageRef) : null,
    parentProviderMessageRef: parentProviderMessageRef ? String(parentProviderMessageRef) : null,
    authorRef: providerActor('slack', actorValue),
    providerMentionIds: extractSlackMentionIds(body),
    reaction: event.reaction || null,
    reactionActorRef: providerActor('slack', event.user || null),
    itemAuthorRef: providerActor('slack', event.item_user || null),
    body,
    bodyRef: providerMessageRef ? `slack:message:${providerMessageRef}/content` : null,
    bodyHash: sha256(body),
    bodyLength: Buffer.byteLength(body, 'utf8'),
    providerVersionRef: providerVersionRef ? String(providerVersionRef) : null,
    createdAt: event.ts ? new Date(Number.parseFloat(event.ts) * 1000).toISOString() : null,
    updatedAt: event.event_ts ? new Date(Number.parseFloat(event.event_ts) * 1000).toISOString() : null,
    verification,
    rawBodyPersisted: false,
    bodyPersisted: false,
  };
}

function githubRepository(payload) {
  const fullName = payload.repository?.full_name;
  if (!fullName || !String(fullName).includes('/')) {
    throw new MessagingError('INBOUND_TARGET_INCOMPLETE', 'GitHub event lacks repository full_name');
  }
  const [owner, repo] = String(fullName).split('/', 2);
  return { owner, repo };
}

function githubCommentEnvelope(payload, eventName) {
  if (eventName === 'issue_comment') {
    return {
      comment: payload.comment,
      number: payload.issue?.number,
      kind: payload.issue?.pull_request ? 'pr' : 'issue',
      parentProviderMessageRef: null,
    };
  }
  if (eventName === 'pull_request_review_comment') {
    return {
      comment: payload.comment,
      number: payload.pull_request?.number,
      kind: 'pr',
      parentProviderMessageRef: payload.comment?.in_reply_to_id || null,
    };
  }
  if (eventName === 'discussion_comment') {
    return {
      comment: payload.comment,
      number: payload.discussion?.number,
      kind: 'discussion',
      parentProviderMessageRef: payload.comment?.parent_comment_id || null,
    };
  }
  return null;
}

export function normalizeGitHubPayload(payload, verification) {
  const eventName = verification.eventName;
  const envelope = githubCommentEnvelope(payload, eventName);
  if (!envelope) {
    return {
      schema: 'road-messaging-inbound-event-v1',
      eventId: verification.deliveryRef,
      providerId: 'github',
      providerEventType: eventName,
      type: 'UNSUPPORTED_EVENT',
      verification,
      rawBodyPersisted: false,
      bodyPersisted: false,
    };
  }

  const actionMap = {
    created: 'MESSAGE_CREATED',
    edited: 'MESSAGE_UPDATED',
    deleted: 'MESSAGE_DELETED',
  };
  const type = actionMap[payload.action] || 'UNSUPPORTED_EVENT';
  const comment = envelope.comment || {};
  const repository = githubRepository(payload);
  if (!envelope.number) throw new MessagingError('INBOUND_TARGET_INCOMPLETE', 'GitHub event lacks issue, PR, or discussion number');
  const target = {
    ...repository,
    kind: envelope.kind,
    number: String(envelope.number),
    commentId: comment.id ? String(comment.id) : null,
  };
  const threadResource = canonicalThreadResource('github', target);
  const body = type === 'MESSAGE_DELETED' ? '' : String(comment.body || '');
  const providerMessageRef = comment.id ? String(comment.id) : null;

  return {
    schema: 'road-messaging-inbound-event-v1',
    eventId: String(verification.deliveryRef),
    providerId: 'github',
    providerEventType: eventName,
    providerEventSubtype: payload.action || null,
    type,
    target,
    threadResource,
    providerMessageRef,
    parentProviderMessageRef: envelope.parentProviderMessageRef ? String(envelope.parentProviderMessageRef) : null,
    authorRef: providerActor('github', comment.user?.login || payload.sender?.login || null),
    providerMentionIds: [...new Set([...body.matchAll(/(^|\s)@([A-Za-z0-9-]+)/g)].map((match) => match[2]))],
    body,
    bodyRef: providerMessageRef ? `github:comment:${providerMessageRef}/content` : null,
    bodyHash: sha256(body),
    bodyLength: Buffer.byteLength(body, 'utf8'),
    providerVersionRef: comment.updated_at || comment.created_at || verification.deliveryRef,
    createdAt: comment.created_at || null,
    updatedAt: comment.updated_at || null,
    verification,
    rawBodyPersisted: false,
    bodyPersisted: false,
  };
}

function validateAdapterEvent(payload, verification) {
  const type = String(payload.type || 'UNSUPPORTED_EVENT');
  if (!INBOUND_EVENT_TYPES.has(type)) throw new MessagingError('INBOUND_EVENT_TYPE_INVALID', `Unsupported normalized event type ${type}`);
  if (!payload.eventId) throw new MessagingError('INBOUND_EVENT_ID_REQUIRED', 'Adapter-normalized event requires eventId');
  if (type !== 'HANDSHAKE' && type !== 'UNSUPPORTED_EVENT' && !payload.target) {
    throw new MessagingError('INBOUND_TARGET_INCOMPLETE', 'Adapter-normalized event requires target');
  }
  const target = payload.target || null;
  const threadResource = target ? canonicalThreadResource(verification.providerId, target) : null;
  const body = String(payload.body || '');
  return {
    schema: 'road-messaging-inbound-event-v1',
    ...payload,
    providerId: verification.providerId,
    type,
    threadResource,
    body,
    bodyRef: payload.bodyRef || (payload.providerMessageRef ? `${verification.providerId}:message:${payload.providerMessageRef}/content` : null),
    bodyHash: sha256(body),
    bodyLength: Buffer.byteLength(body, 'utf8'),
    verification,
    rawBodyPersisted: false,
    bodyPersisted: false,
  };
}

export function normalizeVerifiedWebhook(input) {
  const verification = verifyInboundWebhook(input);
  const parsed = input.payload !== undefined
    ? { text: input.rawBody === undefined ? null : String(input.rawBody), payload: input.payload }
    : parseJsonBody(input.rawBody);
  if (verification.providerId === 'slack') return normalizeSlackPayload(parsed.payload, verification);
  if (verification.providerId === 'github') return normalizeGitHubPayload(parsed.payload, verification);
  return validateAdapterEvent(parsed.payload, verification);
}

export function durableInboundEvent(event) {
  const copy = {
    ...event,
    verification: event.verification ? {
      providerId: event.verification.providerId,
      verified: event.verification.verified,
      verificationMode: event.verification.verificationMode,
      verificationRef: event.verification.verificationRef,
      timestamp: event.verification.timestamp || null,
      deliveryRef: event.verification.deliveryRef || null,
      eventName: event.verification.eventName || null,
      rawBodyHash: event.verification.rawBodyHash || null,
      secretPersisted: false,
    } : null,
  };
  delete copy.body;
  copy.rawBodyPersisted = false;
  copy.bodyPersisted = false;
  return copy;
}

export function inboundDedupeKey(event) {
  return sha256(stableStringify({
    providerId: event.providerId,
    eventId: event.eventId,
    providerMessageRef: event.providerMessageRef || null,
    type: event.type,
    providerVersionRef: event.providerVersionRef || null,
  }));
}
