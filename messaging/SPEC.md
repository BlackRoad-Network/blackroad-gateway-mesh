# BlackRoad Messaging Framework Specification

Status: implementation-ready local control plane; provider writes remain provider-native and approval-gated.

## Objective

Provide one canonical discussion model across Slack, Microsoft Teams, GitHub pull-request and issue comments, Linear discussions, Asana task comments, Notion discussions, Airtable record comments, and future chat adapters.

The system must let six BlackRoad agents discuss the same resource without:

- duplicating messages during mirror loops;
- treating every provider as equally authoritative;
- granting write authority because a connector is authenticated;
- turning provider acknowledgement into unverified success;
- placing provider credentials or secret values in shared state;
- collapsing a timeout into failure;
- leaking private conversation identifiers through a public gateway.

## Canonical identities

```text
road://service/messaging
road://thread/<thread-id>
road://message/<message-id>
```

A canonical thread identifies the discussion. Provider conversations are bindings:

```text
Road thread
  ├── Slack channel/thread
  ├── GitHub PR conversation
  ├── Linear issue discussion
  ├── Notion page discussion
  └── Teams channel/thread
```

One provider binding may be authoritative. Other bindings are projections or read-only references.

## Default topology

```text
canonical Road thread
        │
        ├── reference-only projection
        ├── notification-only projection
        └── explicit full-content projection
```

Bidirectional mirroring is disabled by default. Full-content replication requires an explicit policy because copying a private comment into a public channel is not collaboration. It is an incident report warming up.

## Thread lifecycle

```text
OPEN -> RESOLVED -> ARCHIVED
  └── LOCKED
```

Every thread mutation carries `expectedThreadVersion`. Stale writes fail before provider execution.

## Message lifecycle

```text
PLANNED
  ├── BLOCKED
  ├── POSTED_UNVERIFIED
  │      └── POSTED
  ├── PARTIAL
  ├── FAILED
  └── TIMEOUT_UNKNOWN
```

Inbound provider messages are stored as `RECEIVED`. Editing and deletion are represented explicitly; they do not erase the original receipt history.

## Provider projection lifecycle

```text
PLANNED
  ├── BLOCKED_CAPABILITY
  ├── ACKNOWLEDGED_UNVERIFIED
  │      ├── VERIFIED
  │      └── NOT_APPLIED
  ├── FAILED
  ├── TIMEOUT_UNKNOWN
  └── CANCELLED
```

A provider call returning success transitions to `ACKNOWLEDGED_UNVERIFIED`. Read-after-write verification is required before `VERIFIED`.

## External communication authority

The following provider actions are `COMMUNICATE` operations:

- top-level post;
- threaded reply;
- edit;
- delete;
- reaction;
- mention;
- broadcast.

An external binding requires a `userApprovalRef` before planning one of those actions. Provider authentication is necessary but insufficient.

## Loop prevention

Every outbound projection has:

- canonical Road message ID;
- provider binding ID;
- semantic idempotency key;
- stable request hash;
- provider request reference;
- eventual provider message reference.

Inbound provider events may carry the originating Road message ID. Matching echoes verify the existing projection instead of creating a second canonical message.

## Provider capability truth

Capabilities have four values:

```text
true
false
PARTIAL
UNVERIFIED
```

`UNVERIFIED` never becomes permission. Microsoft Teams, Discord, Google Chat, Telegram, and WhatsApp are represented through Vercel Chat SDK adapter plans but remain blocked until package, app, webhook, and credential requirements are satisfied.

## Collaboration-plane integration

Every provider operation plan yields:

- connector ID;
- canonical resource key;
- action class;
- target-owner context;
- semantic idempotency key;
- stable request hash;
- expected provider version when available;
- provider-native tool and arguments;
- read-back verification plan.

The existing collaboration broker owns sessions, claims, governance, workflow causality, and receipts. The messaging framework owns thread, message, binding, reaction, and projection semantics.

## Public boundary

Public status may expose aggregate counts, protocol version, provider capability status, and event-chain head. It must not expose:

- message bodies;
- channel IDs;
- provider thread IDs;
- provider user IDs;
- private page or record IDs;
- claims;
- approval references;
- credentials;
- raw provider payloads.
