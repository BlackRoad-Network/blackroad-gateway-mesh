# BlackRoad Discussion and Messaging Fabric

The messaging fabric gives BlackRoad one discussion model across agents and provider tools.

## Layers

```text
human / agent / app
        |
road://service/messaging
        |
canonical spaces + threads + messages
        |
road://service/collaboration
        |
intent + claim + invocation + verification + receipt
        |
provider adapters
        |
Slack / GitHub / Teams / Linear / Notion / Gmail / Resend
```

## Why one canonical model

Slack calls a discussion a channel message and thread. Teams uses a channel post and replies. GitHub uses issue comments, pull-request conversation comments, inline review threads, and Discussions. Email has subject-based threads. None of these identifiers are stable enough to serve as BlackRoad identity.

A BlackRoad thread keeps its own Road URI and attaches provider bindings:

```text
road://thread/gateway-rollout
  -> Slack C... / parent timestamp
  -> GitHub PR #3 / conversation
  -> Linear issue / comment root
```

## Discussion semantics

Threads can be `OPEN`, `RESOLVED`, or `ARCHIVED`.

Messages can be:

```text
COMMENT
QUESTION
ANSWER
DECISION
STATUS
BLOCKER
HANDOFF
REVIEW
SYSTEM
```

Edits append revision history. Deletion becomes a tombstone. Reactions are separate objects. Read markers belong to canonical principals.

## Provider delivery semantics

Provider delivery is not automatic. The canonical message is created first. External delivery then requires a separately authorized operation.

A provider success response transitions to:

```text
PROVIDER_ACKNOWLEDGED
```

not:

```text
DELIVERED
```

Delivery becomes `DELIVERED` only after provider-native read-back verifies the intended message or reply.

## Cross-provider bridging

Each bridged message carries:

- canonical origin message ID;
- provider bridge trace;
- hop count;
- semantic dedupe key;
- provider bindings.

A provider already in the trace cannot receive the message again. The default hop limit is four.

## Mentions

Mentions use canonical principals first. Provider user IDs are explicit bindings. Unresolved principals remain plain text and never become accidental channel-wide mentions.

## Current provider status

Slack and GitHub have live connector surfaces. Microsoft Teams has a complete adapter contract but no observed connector. The framework therefore reports `CONNECTOR_UNAVAILABLE`, not “connected through Microsoft somehow,” a sentence that has ruined many implementation meetings.
