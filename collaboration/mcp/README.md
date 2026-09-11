# BlackRoad Collaboration MCP

This stdio MCP adapter exposes the collaboration broker to Claude and other tool-capable agents without making the public gateway a credential proxy.

## Actor binding

Start one server process per runtime session with immutable bindings:

```bash
ROAD_AGENT_ID=agent-instance-4 \
ROAD_SESSION_REF=claude-session-unique \
node collaboration/mcp/server.mjs
```

Tool arguments cannot impersonate another agent or session. Calls are serialized in arrival order, while the state store adds an inter-process lock, atomic replacement, generation counter, and hash-chained events.

## Workflow and queue model

`road_collab_workflow_instantiate` converts a reviewed workflow template into durable agent-owned work items. Dependencies begin `BLOCKED`; satisfied dependencies become `READY` and emit a durable notification. Starting a mutation binds it to the exact live runtime session.

## Delegation

Delegation is an offer, not an invisible reassignment. The owner provides a contract reference and acceptance evidence. Ownership changes only after the addressed target accepts from a live session.

## Completion

Provider success does not complete a mutating work item. A successful mutation requires a read-back `verificationRef`; ambiguous provider outcomes remain `TIMEOUT_UNKNOWN`.

## Verification

```bash
cd collaboration/mcp
npm run verify
```

## Review corrections and remaining gaps

Tool calls reapply the process-bound agent and session after caller arguments.
Delegation acceptance rechecks that work is READY or BLOCKED; running and terminal
work retain their owner. Verified prerequisites require a verification reference
for READ and OBSERVE steps as well as mutations.

The executable broker is not ready for sensitive provider execution: authoritative
governance/approval checks at work start remain an unresolved review finding.
The checks above do not implement those gates.

## State and event-log recovery

The atomic state rename is the transaction commit point. The state retains the
latest 500 hash-chained events. The JSONL file is a recoverable projection: before
a mutation, the store validates its full chain against state and restores any
missing tail from retained events. An unavailable log blocks before the mutator.
After a state commit, projection failure returns `committed: true` and
`eventLogPending: true` from `transact`; it does not report a rollback. Broker
methods continue to return their committed result. They do not repeat the mutation.

`await store.reconcileEvents()` repairs the projection under the same lock without
running a work transition. The next transaction also repairs it before proceeding,
so unresolved projection failures cannot evict recovery events. Truncated or
conflicting logs, logs ahead of state, and gaps older than the retained history
block recovery for operator inspection; they are not silently overwritten.

Temporary files are flushed before atomic replacement. Initialization and recovery
share the transaction lock. Lock age never permits automatic takeover: after a
process crash, stop all users of the store and establish that the owner is gone
before removing its lock. A failed cleanup leaves further mutations blocked.

This is a small local-filesystem reference store: recovery reads and rewrites the
complete JSONL projection, so cost grows with history. It does not establish
network-filesystem or sudden-power-loss guarantees. A process dying before a
response still requires reading the saved state or using existing operation
idempotency; these changes do not make arbitrary caller retries exactly once.
