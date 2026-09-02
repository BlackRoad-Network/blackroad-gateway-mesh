# Claude messaging MCP profiles

These profiles bind one stable BlackRoad actor to the local messaging MCP while allowing the launcher to create a fresh runtime session for every process.

Profiles:

```text
agent-instance-1.json
agent-instance-2.json
agent-instance-3.json
agent-instance-4.json
agent-instance-5.json
agent-instance-6.json
connector-orchestrator.json
```

Every profile starts:

```text
/Users/alexa/workspace/system/messaging/launch-agent-mcp.sh <stable-agent-id>
```

The launcher exports:

```text
ROAD_AGENT_ID
ROAD_SESSION_REF
ROAD_WORKSPACE_ROOT
ROAD_MESSAGING_STATE_ROOT
```

Unless the caller supplies an existing approved `ROAD_SESSION_REF`, the launcher generates a session identity containing the stable actor, host, process ID, and start time. Two concurrent Claude processes using the same logical agent therefore remain separate runtime sessions and cannot inherit each other's inbox or outbox claims.

These examples are not installed into a global Claude configuration automatically. Copy or merge only the profile needed by the exact Claude instance after reviewing its path and actor identity.

The messaging MCP can read its exact-session inbox, register bounded subscriptions, acknowledge its own inbox items, plan provider operations, and inspect provider capabilities. Only `connector-orchestrator` and `agent-instance-4` may prepare or finish collaboration-handoff outbox delivery.

The MCP does not send Slack messages, Teams messages, GitHub comments, or other provider communications itself. Provider writes remain provider-native and must pass the collaboration claim, approval, verification, and receipt lifecycle.
