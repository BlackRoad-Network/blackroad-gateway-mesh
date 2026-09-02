# First-class connector collaboration

This directory defines the connector-aware collaboration layer for BlackRoad agents.

It extends the existing collaboration control plane rather than replacing it. Connector sessions, operations, leases, events, handoffs, and receipts are represented as durable protocol objects with explicit authority and recovery semantics.

## Invariants

- A connector being authenticated does not authorize an agent to use every connector operation.
- Provider account identifiers are references. Secret values and raw credentials never enter collaboration events or receipts.
- A timeout remains `TIMEOUT_UNKNOWN`; it is not rewritten as offline, failed, or nonexistent.
- An empty result may be valid and is represented as `SUCCEEDED_EMPTY`.
- Every mutating operation requires an idempotency key.
- Read leases may coexist. Write, deploy, admin, secret-reference, and public-expose leases are exclusive for the same resource scope.
- Lease fencing tokens prevent a stale session from completing work after ownership has moved.
- A handoff is not complete until the receiving session acknowledges it.
- Real provider writes remain behind provider-native authentication and the applicable BlackRoad capability or governance decision.

## Components

- `protocol.mjs`: validation, normalization, authority ranking, resource keys, receipt redaction, and event construction.
- `runtime.mjs`: in-memory reference runtime for sessions, fenced leases, idempotent dispatch, workflow dependencies, handoffs, receipts, recovery, and replay.
- `mcp-tools.mjs`: MCP tool descriptions and a handler adapter that can be mounted into the existing collaboration MCP server.
- `schemas/*.schema.json`: durable protocol contracts.
- `workflows/*.json`: connector-to-connector workflow examples that are plans, never implicit authorization.
- `tests/*.test.mjs`: executable behavioral contract.

## Agent identity

Agents are identified as `agent-instance-1` through `agent-instance-6`. Each tool-backed connector session additionally records:

- runtime and model
- connector id and provider
- redacted account reference
- granted capabilities
- authority scopes
- heartbeat and lifecycle state
- held lease ids

## Operation lifecycle

```text
PLANNED
  -> BLOCKED_DEPENDENCY | BLOCKED_AUTHORITY | READY
  -> LEASED
  -> RUNNING
  -> SUCCEEDED | SUCCEEDED_EMPTY | FAILED | TIMEOUT_UNKNOWN | CANCELLED
  -> RECEIPTED
```

Recovery may requeue only operations declared idempotent. A stale writer loses its fencing token and cannot later commit a result.

## Integration

The existing collaboration MCP server should import `connectorTools` and delegate matching calls to `createConnectorToolHandler({ runtime })`. The adapter deliberately returns ordinary values and does not own stdio, JSON-RPC, or daemon lifecycle, avoiding another rival control plane.
