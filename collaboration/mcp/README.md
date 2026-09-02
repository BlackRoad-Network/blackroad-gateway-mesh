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

## Provider invocation envelope

Before a provider-native connector call, the agent records an invocation with its workflow, work item, connector, tool, resource, action class, session, idempotency key, and secret-free request hash. Provider acknowledgement moves the work item to `VERIFYING`; separate read-back evidence is required for successful completion.

## Delegation

Delegation is an offer, not an invisible reassignment. The owner provides a contract reference and acceptance evidence. Ownership changes only after the addressed target accepts from a live session.

## Verification

```bash
cd collaboration/mcp
npm run verify
```
