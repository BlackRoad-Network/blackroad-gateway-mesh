# BlackRoad Conversation Fabric

Canonical identity: `road://service/conversations`

Aliases: `road://messaging`, `road://service/messaging`

Private service identity: `svc:conversations`

This layer normalizes channels, threads, messages, comments, discussions, reactions, mentions, drafts, attachments, and review conversations across Slack, Microsoft Teams, Google Chat, Discord, Telegram, WhatsApp, GitHub, Linear, Gmail, Resend, Notion, Google Drive, Asana, GitBook, SharePoint, Zoom Team Chat, Matrix, and BlackRoad itself.

## Boundary

Road owns stable conversation identity, provider bindings, causality, operation classification, loop prevention, collaboration claims, verification requirements, and receipts.

Provider adapters continue to own authentication, request signing, transport, message rendering, and actual delivery. The public gateway exposes metadata only and never acts as an unauthenticated message relay.

## Conversation identity

One Road conversation may have several bindings:

```text
road://conversation/<stable-id>
  ├─ Slack channel/thread
  ├─ GitHub PR discussion
  ├─ Linear issue thread
  ├─ Notion page discussion
  └─ Gmail thread
```

Provider IDs are locations, not the canonical identity.

## Mutation flow

```text
session heartbeat
  -> COMMUNICATE or ADMIN intent
  -> explicit owner and idempotency key
  -> user approval and governance where required
  -> exclusive claim
  -> invocation.start with safe request hash
  -> provider-native tool call
  -> provider response
  -> provider-native read-back
  -> VERIFIED receipt
```

A provider timeout remains `TIMEOUT_UNKNOWN`. A successful API response enters `VERIFYING`; it is not final proof.

## Loop prevention

- provider event deduplication;
- own-message echo suppression;
- correlation and causation IDs;
- bounded cross-platform bridge hops;
- route trace loop detection;
- no automatic cross-posting by default.

## Current observed posture

Slack channel discovery and history reads are verified. The existing `eng-collaboration` channel is represented through a private environment reference rather than publishing its provider ID.

Microsoft Teams has an official Chat SDK adapter contract but no connected Teams app was observed. Its state is therefore `ADAPTER_AVAILABLE_CONFIG_REQUIRED`, not pretend-connected.

## CLI

```bash
node messaging/road-message.mjs status
node messaging/road-message.mjs platforms
node messaging/road-message.mjs operations
node messaging/road-message.mjs capability slack message.reply
node --test messaging/runtime.test.mjs
```

The CLI plans collaboration commands. It does not send messages.
