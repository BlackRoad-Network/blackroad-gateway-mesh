import { MessagingError, canonicalThreadResource, providerById } from './framework.mjs';

function required(target, name) {
  const value = target?.[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new MessagingError('TARGET_FIELD_REQUIRED', `Target field ${name} is required`);
  }
  return value;
}

function linearParent(target) {
  const entityType = String(target.entityType || 'issue').toLowerCase();
  const mapping = {
    issue: 'issueId',
    project: 'projectId',
    initiative: 'initiativeId',
    document: 'documentId',
    milestone: 'milestoneId',
    'status-update': 'statusUpdateId',
  };
  const key = mapping[entityType];
  if (!key) throw new MessagingError('UNSUPPORTED_LINEAR_PARENT', `Unsupported Linear parent: ${entityType}`);
  return { [key]: required(target, 'entityId') };
}

export function providerArguments(input) {
  const provider = providerById(input.providerId);
  const target = input.target || {};
  const operation = input.operation;
  canonicalThreadResource(provider.id, target);

  if (provider.id === 'slack') {
    const channel_id = String(required(target, 'channelId'));
    if (operation === 'readThread') {
      return { channel_id, message_ts: String(required(target, target.threadTs ? 'threadTs' : 'messageTs')) };
    }
    if (operation === 'createThread') return { channel_id, message: String(input.body || '') };
    if (operation === 'reply') return { channel_id, thread_ts: String(required(target, 'threadTs')), message: String(input.body || '') };
    if (operation === 'edit') return { channel_id, message_id: String(required(target, 'messageId')), message: { markdown_text: String(input.body || '') } };
    if (operation === 'delete') return { channel_id, message_id: String(required(target, 'messageId')) };
    if (operation === 'react') return { channel_id, message_ts: String(required(target, 'messageTs')), emoji: String(required(input, 'emoji')).replaceAll(':', '') };
  }

  if (provider.id === 'github') {
    const base = {
      repo_full_name: `${String(required(target, 'owner'))}/${String(required(target, 'repo'))}`,
      pr_number: Number(required(target, 'number')),
    };
    if (operation === 'readThread') return base;
    if (operation === 'createThread' || operation === 'reply') return { ...base, comment: String(input.body || '') };
    if (operation === 'reviewReply') return { ...base, comment_id: Number(required(target, 'commentId')), comment: String(input.body || '') };
    if (operation === 'edit') return { repo_full_name: base.repo_full_name, comment_id: Number(required(target, 'commentId')), comment: String(input.body || '') };
    if (operation === 'react') return { repo_full_name: base.repo_full_name, comment_id: Number(required(target, 'commentId')), reaction: String(required(input, 'emoji')) };
    if (operation === 'resolve' || operation === 'reopen') return { thread_id: String(required(target, 'threadId')) };
  }

  if (provider.id === 'linear') {
    if (operation === 'readThread') return linearParent(target);
    if (operation === 'createThread') return { ...linearParent(target), body: String(input.body || '') };
    if (operation === 'reply') return { parentId: String(required(target, 'parentCommentId')), body: String(input.body || '') };
    if (operation === 'edit') return { id: String(required(target, 'commentId')), body: String(input.body || '') };
    if (operation === 'delete') return { id: String(required(target, 'commentId')) };
    if (operation === 'reviewReply') return { urlOrId: String(required(target, 'reviewId')), parentId: String(required(target, 'parentCommentId')), body: String(input.body || '') };
    if (operation === 'resolve') return { threadId: String(required(target, 'threadId')), resolved: true };
    if (operation === 'reopen') return { threadId: String(required(target, 'threadId')), resolved: false };
  }

  if (provider.id === 'asana') {
    if (operation === 'readThread') return { task_id: String(required(target, 'taskId')), include_comments: true };
    if (operation === 'createThread') return { task_id: String(required(target, 'taskId')), text: String(input.body || '') };
  }

  if (provider.id === 'notion') {
    const page_id = String(required(target, 'pageId'));
    if (operation === 'readThread') return { page_id, include_all_blocks: Boolean(target.includeAllBlocks), include_resolved: Boolean(target.includeResolved) };
    if (operation === 'createThread') {
      return {
        page_id,
        markdown: String(input.body || ''),
        ...(target.selectionWithEllipsis ? { selection_with_ellipsis: String(target.selectionWithEllipsis) } : {}),
      };
    }
    if (operation === 'reply') return { page_id, discussion_id: String(required(target, 'discussionId')), markdown: String(input.body || '') };
  }

  if (provider.id === 'airtable') {
    const base = {
      baseId: String(required(target, 'baseId')),
      tableId: String(required(target, 'tableId')),
      recordId: String(required(target, 'recordId')),
    };
    if (operation === 'readThread') return base;
    if (operation === 'createThread') return { ...base, text: String(input.body || '') };
    if (operation === 'reply') return { ...base, parentCommentId: String(required(target, 'parentCommentId')), text: String(input.body || '') };
  }

  if (provider.surface.startsWith('vercel-chat-sdk')) {
    const capability = provider.operations?.[operation];
    if (!capability) throw new MessagingError('UNSUPPORTED_OPERATION', `${provider.label} does not expose ${operation}`);
    return {
      adapter: provider.adapter,
      method: capability.tool.replace(/^chat-sdk\./, ''),
      target,
      content: input.body === undefined ? null : String(input.body),
      emoji: input.emoji || null,
    };
  }

  throw new MessagingError('UNSUPPORTED_OPERATION', `${provider.label} does not expose ${operation}`);
}
