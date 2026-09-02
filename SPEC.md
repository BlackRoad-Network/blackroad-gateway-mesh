# BlackRoad Messaging Framework Specification

Status: implementation-complete for the local control plane; provider execution remains provider-native.

## Problem

BlackRoad has six stable workspace agents, a connector orchestrator, and many provider tools. They need a shared discussion model that works across Slack threads, Microsoft Teams posts, GitHub comments, Linear comments, Notion comments, email threads, and future Road-native clients without treating any provider-specific message ID as the canonical identity.

A provider message is a projection of a BlackRoad discussion, not the discussion itself.

## Users

- Alexa as the human operator.
- `agent-instance-1` through `agent-instance-6`.
- `connector-orchestrator`.
- Approved external collaborators represented by explicit provider bindings.

## Goals

1. Local-first spaces, threads, messages, replies, reactions, read markers, and thread resolution.
2. Durable edit and tombstone history.
3. Canonical Road identities independent of Slack, Teams, GitHub, or another provider.
4. Explicit provider bindings and delivery receipts.
5. First-class collaboration intent, claim, invocation, verification, and receipt references.
6. Cross-provider fan-out without echo loops or duplicate posts.
7. Provider-native authentication.
8. Exact runtime-session ownership for outbound delivery.
9. `TIMEOUT_UNKNOWN` preservation until provider read-back resolves the effect.
10. Claude-accessible MCP tools and a loopback-only HTTP service.

## Non-goals

- Replacing Slack or Teams.
- Proxying provider credentials.
- Publicly exposing the messaging daemon.
- Treating email as the canonical thread store.
- Silently copying every message between providers.
- Sending messages merely because a connector is authenticated.
- Hard-deleting canonical history.

## Canonical identities

```text
road://service/messaging
road://space/<space-id>
road://thread/<thread-id>
road://message/<message-id>
```

Provider projections use:

```text
road+connector://<provider>/<canonical-provider-resource>
```

## Objects

- Space
- Thread
- Message
- Reaction
- Mention
- Provider binding
- Delivery
- Read marker
- Attachment reference

## Message kinds

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

## Security and authority

Internal canonical messages are local state mutations.

External provider operations are `COMMUNICATE` actions and require:

- a live runtime session;
- the target owner;
- a semantic idempotency key;
- an exclusive collaboration claim;
- explicit user-approval evidence;
- provider-native authentication;
- read-after-write verification;
- a final receipt.

Provider authentication never implies authority to communicate.

## Provider posture

- Slack: connected and thread-capable.
- GitHub: connected and comment/review-thread capable.
- Linear: connected and comment-capable.
- Notion: connected; comment support is capability-dependent.
- Gmail: connected; treated as an email-thread delivery adapter.
- Resend: configured as a transactional adapter but remains `READY_EMPTY` until domain/webhook prerequisites are verified.
- Microsoft Teams: adapter contract exists; no authenticated Teams connector is currently exposed.

## Acceptance criteria

- `npm run verify` passes.
- The local daemon binds to loopback only.
- The MCP server supports newline and `Content-Length` framing.
- Canonical posting does not automatically execute provider writes.
- External delivery cannot be planned without approval, collaboration intent, and claim references.
- Provider success requires read-after-write verification.
- Timeouts remain `TIMEOUT_UNKNOWN`.
- Event-chain tampering is detected.
- Cross-provider bridge loops are rejected.
- Secret-like values are rejected or redacted before persistence.
