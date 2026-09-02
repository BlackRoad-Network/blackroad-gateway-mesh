# Messaging framework handoff

Owner: connector-orchestrator / agent-instance-4 integration lane

Target base: `gateway-collaboration-v1`

Owned paths:

- `messaging/**`
- `skills/road-messaging-fabric/**`
- `MESSAGING-FRAMEWORK.md`
- `.github/workflows/messaging-framework.yml`

The package is intentionally provider-execution-free. It plans exact native connector calls and requires the existing collaboration broker for sessions, claims, invocations, verification, receipts, and handoffs.

Claude should consume the framework as a sibling layer rather than rewriting `collaboration/core.mjs`. The integration seam is `messaging/framework.mjs` plus the thirteen tools in `messaging/mcp-server.mjs`.

No Slack, GitHub discussion, Linear comment, Asana comment, Notion comment, Airtable comment, Teams message, or other provider message was created as a test fixture.
