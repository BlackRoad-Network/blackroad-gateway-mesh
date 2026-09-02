---
name: road-conversation-fabric
version: 1.0.0
description: Coordinate provider-neutral channels, threads, comments, messages, reactions, mentions, drafts, attachments, and review discussions across Slack, Teams, GitHub, Linear, Notion, Drive, Asana, email, and other adapters. Use when a task reads or changes discussion state, bridges a conversation across providers, or turns a discussion into an agent handoff. Do not use for a provider-independent one-shot file or database operation with no conversation surface.
---

# Road Conversation Fabric

## Activation

Activate for channels, threads, messages, comments, discussions, mentions, reactions, drafts, replies, reviews, and cross-platform conversation continuity.

Do not activate merely because a provider can send notifications. Use the provider specialist directly when the task is isolated and no shared thread, handoff, or collaboration state is involved.

## Classification

Classify before touching a provider:

- `READ`: list, search, read, or inspect conversation state.
- `WRITE`: create, update, or delete an unsent draft.
- `COMMUNICATE`: post, reply, comment, react, edit, delete, schedule, resolve, or otherwise create externally visible discussion state.
- `ADMIN`: create or archive channels, manage subscriptions, or register webhooks.

Also classify visibility, provider configuration state, target ownership, anchor requirements, and whether the action participates in a cross-connector workflow.

## Protocol

1. Resolve the Road conversation and provider binding.
2. Read the current provider thread when context or a version reference matters.
3. Select one provider adapter and confirm the operation is supported.
4. For a mutation, establish a live collaboration session, durable intent, target owner, idempotency key, content reference/hash, and exclusive claim.
5. Require explicit user approval for every `COMMUNICATE` operation.
6. Require governance and user approval for `ADMIN` operations.
7. Record `invocation.start` before the provider-native call.
8. Keep message content and secrets outside collaboration and public gateway metadata.
9. Execute through the provider-native adapter.
10. Preserve `TIMEOUT_UNKNOWN` when delivery is ambiguous.
11. Read the message, thread, comment, reaction, draft, or channel back from the provider.
12. Record a successful receipt only after verification.
13. Publish an addressed handoff when another agent owns the resulting work.

## Provider-specific anchors

- Slack: channel reference plus parent message timestamp for replies.
- Teams and chat adapters: tenant/workspace, channel, conversation/thread, and activity/message references.
- GitHub: repository plus issue, pull request, discussion, review thread, or comment reference.
- Linear: issue, project, document, or diff plus thread/comment reference.
- Notion: page plus discussion or content-selection reference.
- Google Drive: file plus comment/reply and quoted text, slide, or sheet-range context.
- Asana: task plus story/comment reference.
- Gmail: thread plus source-message reference for replies.

Never substitute a display name for a stable provider reference when a write is about to occur.

## Invariants

- Provider identity is not Road conversation identity.
- Logical agent identity is not runtime-session identity.
- App connection is not permission to communicate.
- A draft is not a sent message.
- Provider acknowledgement is not verified delivery.
- A timeout is not failure or success.
- Raw content and credentials never enter public gateway or collaboration control state.
- Automatic cross-posting is disabled by default.
- Own echoes and duplicate provider events do not re-trigger agents.
- Every externally visible operation is attributable to one user-approved intent.

## Failure classes

- `CONFIG_REQUIRED`: adapter exists but the provider is not configured.
- `UNSUPPORTED_OPERATION`: provider does not expose the normalized operation.
- `ANCHOR_REQUIRED`: comment or reply target is ambiguous.
- `BLOCKED_USER_APPROVAL`: external communication lacks explicit approval.
- `BLOCKED_GOVERNANCE`: administrative operation lacks a decision receipt.
- `RESOURCE_VERSION_CONFLICT`: target changed after observation.
- `DUPLICATE_PROVIDER_EVENT`: inbound event was already handled.
- `OWN_ECHO`: outbound delivery returned as an inbound event.
- `BRIDGE_HOP_LIMIT`: cross-platform route exceeded the configured bound.
- `TIMEOUT_UNKNOWN`: provider may have accepted the action but no fresh evidence resolves it.
- `VERIFICATION_FAILED`: provider read-back did not prove the requested state.

## Invalid shortcuts

- Sending an acknowledgement merely because a thread was read.
- Treating broad app permission as consent to post.
- Converting Teams adapter availability into a connected-state claim.
- Retrying a timed-out comment without first reading the thread.
- Bridging every future reply because one cross-post was authorized.
- Publishing raw message bodies in receipts or gateway metadata.
- Marking delivery complete from the provider response alone.

## Handoff

Return Road conversation ID, provider-binding references, operation, action class, intent/invocation/receipt references, observed version, verification evidence, unresolved anchors, and any open delivery ambiguity. Do not hand off raw credentials or message bodies when a content reference suffices.
