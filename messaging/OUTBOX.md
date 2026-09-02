# Messaging collaboration outbox

Provider events may create addressed handoff plans for another BlackRoad agent. Those plans are stored in a reference-only outbox until the collaboration broker accepts and verifies them.

## Lifecycle

```text
PENDING
  → CLAIMED by connector-orchestrator or agent-instance-4
  → road-collab handoff.create
  → broker read-back verification
  → DELIVERED
```

Failure states:

```text
FAILED
CANCELLED
TIMEOUT_UNKNOWN
```

A timed-out broker call remains `TIMEOUT_UNKNOWN`, retains the exact session claim, and cannot be retried blindly. The drainer must query the collaboration broker for an existing handoff before deciding whether another attempt is safe.

## Ownership

Only:

```text
connector-orchestrator
agent-instance-4
```

may claim outbox delivery. Claims are bound to one exact runtime session and expire back to `PENDING` only when their lease genuinely expires.

## Bridge

`road-collab-adapter.mjs` converts an outbox item into a canonical collaboration command with:

- source and destination agent IDs;
- connector ID;
- canonical messaging resource;
- artifact and evidence references;
- requested action;
- semantic idempotency key;
- stable non-secret request hash.

The bridge does not invoke provider connectors and does not move credentials. Successful broker delivery requires both a handoff reference and a broker read-back verification reference before the outbox item becomes `DELIVERED`.
