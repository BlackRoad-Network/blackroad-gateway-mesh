# Road conversation protocol reference

## Stable identity and provider bindings

The Road conversation is the durable object. A Slack thread timestamp, Teams activity ID, GitHub review thread, Linear comment thread, Notion discussion, Drive comment, Asana story, or Gmail thread is a binding. Bindings may disappear or change availability without deleting the Road conversation.

## Content plane and control plane

The collaboration control plane stores content references and SHA-256 hashes, not plaintext messages. The content plane remains provider-native or an explicitly authorized private store. This prevents public metadata endpoints, receipts, conflicts, and handoffs from becoming accidental archives of private discussion content.

## Inbound event handling

1. Verify provider webhook or connector authenticity.
2. Normalize provider identity and provider event ID.
3. Reject duplicate provider events.
4. Reject own-message echoes unless an explicit workflow expects them.
5. Resolve or create the Road conversation binding.
6. Store safe event metadata and the content hash.
7. Route mentions or requested actions through the collaboration broker.
8. Preserve source, uncertainty, and provider version references.

## Outbound handling

1. Resolve exact destination references.
2. Classify the operation as read, draft write, communication, or administration.
3. Satisfy collaboration, governance, and user-approval gates.
4. Compute a semantic idempotency key from operation and destination, never from a retry counter.
5. Record invocation start with a safe request-shape hash.
6. Call the provider once.
7. On timeout, read the target thread or message history before retrying.
8. Verify provider state through the native read surface.
9. Record the receipt and any addressed handoff.

## Thread bridging

Bridging is opt-in. Each bridged event carries correlation ID, causation ID, hop count, and route trace. A repeated route element or exhausted hop budget terminates forwarding. Formatting loss is recorded rather than hidden. Provider edits and deletions do not automatically cascade unless the workflow explicitly authorizes that behavior.

## Discussion semantics

Comments, messages, replies, and review notes share a normalized operation model but retain provider semantics. Resolving a GitHub or Linear thread is not equivalent to deleting a Slack message. Each adapter declares supported operations and its verification strategy.

## Anchor rules

Provider writes must use stable object references rather than names. Google Drive comments should preserve quoted text, slide number, or sheet range when applicable. Notion comments should preserve the discussion or selected-content reference. Slack replies require the parent thread timestamp. Gmail replies require the source message/thread relationship. Missing anchors are a blocking ambiguity, not an invitation to post somewhere nearby and hope.
