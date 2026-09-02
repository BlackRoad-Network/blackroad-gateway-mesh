# BlackRoad connector collaboration protocol

Status: implementation-ready, local-first, public deployment not required.

Canonical service:

```text
road://service/collaboration
svc:blackroad-collaboration
```

This protocol lets the six stable BlackRoad agents collaborate even when their runtime changes between Claude, ChatGPT, Codex, Roadie, or another approved client. Runtime and model names are evidence, not authority.

## Why this exists

Connector access creates a concurrency problem. Two agents can both observe a repository, task, domain, deployment, calendar event, or provider object and then mutate stale state. A successful tool call can also be mistaken for completion of a larger workflow. The collaboration plane makes those states explicit instead of relying on everyone being unusually careful forever, a strategy with a poor historical record.

## Stable actor and ephemeral session

The stable identities remain:

```text
road://agent/agent-instance-1
...
road://agent/agent-instance-6
```

Each runtime launch registers a separate session:

```text
session_<uuid>
```

A Claude session and a ChatGPT session may represent different agents, or successive sessions of the same stable agent. No trust or permission is inferred from the runtime name.

## Connector operation envelope

Every connector operation should carry:

- operation ID
- idempotency key
- correlation ID
- optional causation ID
- stable agent ID
- ephemeral session ID
- runtime
- connector ID and operation
- authority class
- canonical target reference
- expected target version when supported
- evidence references
- privacy posture

Mutation authority classes require an active claim:

```text
write
deploy
admin
secret
public-exposure
```

Metadata and provider reads may run concurrently. Reads still produce observations or receipts when they influence a decision.

## Claims and leases

A claim is an expiring exclusive lease over:

```text
connector + canonical target
```

Examples:

```text
github::BlackRoad-Network/blackroad-gateway-mesh@gateway-collaboration-v1:COLLABORATION.md
linear::workspace/project/issue
netlify::site-id/deploy
tailscale::tailnet/policy
google-calendar::calendar-id/event-id
```

Rules:

1. One active mutation per stable agent.
2. One active mutation for a connector target.
3. Every mutation has an idempotency key.
4. Claims expire and are reaped instead of becoming immortal folklore.
5. Provider versions such as a Git blob SHA, ETag, revision ID, or updated-at value are checked when available.
6. A conflict stops the mutation and creates a handoff or reconciliation item. It never triggers a blind overwrite.

## Handoffs

A handoff is a typed, expiring object with:

- sender session
- recipient stable agent
- correlation and causation IDs
- summary
- required action
- connector and target references
- evidence references
- acknowledgement state

The recipient must acknowledge it. Writing a note into a folder does not prove anyone consumed it. Apparently files do not read themselves.

Lifecycle:

```text
OFFERED -> ACCEPTED -> COMPLETED
                    -> REJECTED
         -> EXPIRED
```

## Receipts

Completing a claim creates an append-only receipt recording:

- operation and idempotency IDs
- actor and session
- connector and target
- authority mode
- expected, observed, and resulting versions
- result
- evidence references
- error classification
- redactions
- explicit assertion that no secret value was persisted

Results remain distinct:

```text
SUCCEEDED
FAILED
UNKNOWN
CANCELLED
COMPENSATED
```

A timeout is `TIMEOUT_UNKNOWN`, not offline. A successful query returning zero is `EMPTY_OBSERVATION`, not proof that the resource never existed. Authentication rejection is not network absence. Provider success is not automatically completion of the surrounding workflow.

## Connector roles

The topology assigns explicit responsibilities:

- GitHub or Forgejo: source and review
- Linear, mirrored where useful to Asana: work graph
- Airtable: structured operational registry
- Notion, GitBook, Drive, or SharePoint: durable documentation
- Slack, Resend, or Gmail: notifications
- Neura Relay: decision gate
- 1Password: secret-value authority; collaboration state stores references only
- Tailscale: private service identity and transport
- Netlify: public read-only directory after authorization
- PostHog: telemetry, never authority

No connector silently becomes canonical for another plane.

## Local state

Default state root:

```text
/Users/alexa/workspace/.road-agents/collaboration
```

Files:

```text
state.json       current sessions, claims, handoffs, and compact receipts
events.jsonl     append-only collaboration events
receipts.jsonl   append-only operation receipts
.lock/           exclusive local state lock
```

State writes use a temporary file plus atomic rename while holding an exclusive lock.

## CLI

Run from this repository:

```bash
bin/road-collab init

bin/road-collab register \
  --agent agent-instance-4 \
  --runtime claude \
  --model claude

bin/road-collab claim \
  --session SESSION_ID \
  --connector github \
  --target 'BlackRoad-Network/blackroad-gateway-mesh@branch:path' \
  --mode write \
  --operation file.update \
  --idempotency 'github:repo:branch:path:desired-version'

bin/road-collab complete \
  --session SESSION_ID \
  --claim CLAIM_ID \
  --result succeeded \
  --resulting-version COMMIT_OR_BLOB_SHA \
  --evidence github:commit/COMMIT_SHA

bin/road-collab handoff \
  --from-session SESSION_ID \
  --to-agent agent-instance-3 \
  --kind domain-resolution \
  --summary 'Resolve the verified service identity' \
  --evidence road://service/gateway

bin/road-collab status
bin/road-collab doctor
```

Use `ROAD_WORKSPACE` or `ROAD_COLLAB_HOME` to override the default state location.

## Public boundary

The public gateway may expose only a sanitized collaboration manifest and aggregate counts. It must not publish live target references, private handoff content, provider account metadata, secrets, or mutation claims.

Public deployment remains subject to the existing Neura decision gate. This protocol does not weaken or bypass it.
