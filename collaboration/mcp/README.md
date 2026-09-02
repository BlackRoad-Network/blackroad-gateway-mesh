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
