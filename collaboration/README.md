# BlackRoad collaboration plane

Canonical service: `road://service/collaboration`

Private service identity: `svc:collaboration`

The collaboration plane coordinates concurrent BlackRoad agents and connector calls. It is not a provider credential proxy.

Protocol v2 adds first-class runtime sessions, workflows, connector invocations, shared resource versions, read-after-write verification, and explicit compensation metadata on top of intents, claims, handoffs, observations, receipts, conflicts, heartbeats, and the hash-chained event ledger.

Generated public-safe configuration:

- `protocol.json`
- `agents.json`
- `connectors.json`
- `observation-statuses.json`

Runtime schemas:

- `collaboration-command.schema.json`
- `invocation.schema.json`
- `resource.schema.json`

Local broker state lives under `/Users/alexa/workspace/.road-agents/shared/collaboration` when `road-collab` runs in workspace mode. Provider operations still execute through their native connectors after the collaboration preflight succeeds.
