import { MessagingError } from './framework.mjs';

function providerEntry(identityMap, mentionRef, providerId) {
  const identity = identityMap?.identities?.find((item) => item.ref === mentionRef);
  if (!identity) {
    throw new MessagingError('MENTION_IDENTITY_UNMAPPED', `No canonical identity mapping exists for ${mentionRef}`);
  }
  const mapping = identity.providers?.[providerId];
  if (!mapping) {
    throw new MessagingError('MENTION_PROVIDER_UNMAPPED', `${mentionRef} has no ${providerId} mention mapping`);
  }
  return { identity, mapping };
}

export function formatMention(providerId, mentionRef, identityMap) {
  const provider = String(providerId || '').toLowerCase();
  const { identity, mapping } = providerEntry(identityMap, mentionRef, provider);

  if (provider === 'slack') {
    if (mapping.kind === 'user' && mapping.id) return `<@${mapping.id}>`;
    if (mapping.kind === 'user-group' && mapping.id) {
      return `<!subteam^${mapping.id}${mapping.handle ? `|@${mapping.handle}` : ''}>`;
    }
  }

  if (provider === 'github' || provider === 'linear') {
    const handle = mapping.handle || mapping.displayName;
    if (handle) return `@${String(handle).replace(/^@/, '')}`;
  }

  if (provider === 'airtable') {
    if (mapping.id) return `@[${mapping.id}]`;
  }

  if (provider === 'asana') {
    if (mapping.gid) return `<a data-asana-gid="${mapping.gid}"/>`;
  }

  if (provider === 'notion') {
    if (!mapping.id) throw new MessagingError('MENTION_PROVIDER_ID_REQUIRED', `Notion mapping for ${mentionRef} needs an id`);
    return {
      type: 'mention',
      mention: {
        type: 'user',
        user: { object: 'user', id: mapping.id },
      },
    };
  }

  if (mapping.id || mapping.handle) {
    return {
      adapter: mapping.adapter || provider,
      mentionRef,
      providerIdentity: mapping.id || mapping.handle,
      displayName: mapping.displayName || identity.label || mentionRef,
    };
  }

  throw new MessagingError('MENTION_FORMAT_UNSUPPORTED', `No reviewed mention format exists for ${provider}`);
}

export function resolveInboundMention(providerId, providerIdentity, identityMap) {
  const provider = String(providerId || '').toLowerCase();
  const raw = String(providerIdentity || '').replace(/^@/, '');

  for (const identity of identityMap?.identities || []) {
    const mapping = identity.providers?.[provider];
    if (!mapping) continue;
    const candidates = [mapping.id, mapping.handle, mapping.displayName]
      .filter(Boolean)
      .map((value) => String(value).replace(/^@/, ''));
    if (candidates.includes(raw)) {
      return {
        state: 'RESOLVED',
        mentionRef: identity.ref,
        providerId: provider,
        providerIdentity,
      };
    }
  }

  return {
    state: 'UNRESOLVED',
    mentionRef: null,
    providerId: provider,
    providerIdentity,
  };
}

export function planMentionedMessage(input) {
  let content = String(input.body || '');
  const providerMentions = [];
  const unresolved = [];

  for (const mentionRef of input.mentionRefs || []) {
    try {
      const formatted = formatMention(input.providerId, mentionRef, input.identityMap);
      providerMentions.push({ mentionRef, formatted });
      if (typeof formatted === 'string') content = `${formatted} ${content}`.trim();
    } catch (error) {
      if (error.code === 'MENTION_IDENTITY_UNMAPPED' || error.code === 'MENTION_PROVIDER_UNMAPPED') {
        unresolved.push({ mentionRef, reason: error.code });
        continue;
      }
      throw error;
    }
  }

  return {
    schema: 'road-messaging-mention-plan-v1',
    state: unresolved.length ? 'BLOCKED' : 'READY',
    providerId: input.providerId,
    canonicalMentionRefs: [...(input.mentionRefs || [])],
    providerMentions,
    unresolved,
    transientContent: content,
    persistence: {
      storeCanonicalRefs: true,
      storeProviderIdentityValues: false,
      storeRenderedBody: false,
    },
  };
}
