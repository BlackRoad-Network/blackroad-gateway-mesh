# BlackRoad Messaging Stack v1.2.0

This stacked branch adds a provider-neutral discussion plane on top of `gateway-collaboration-v1` without editing Claude's collaboration core.

Canonical identities:

- `road://service/messaging`
- `road://thread/<id>`
- `road://message/<id>`

The implementation covers canonical threads, replies, edits, tombstones, reactions, provider bindings, delivery projections, exact runtime-session ownership, idempotency, timeout reconciliation, read-after-write verification, echo deduplication, public redaction, CLI access, and Claude-compatible MCP access.

Current observed provider posture:

- Slack: `READ_WRITE_DISCUSSION`
- GitHub: `READ_WRITE_DISCUSSION`
- Linear, Notion, Asana, Airtable: read-only discussion surfaces
- Microsoft Teams: adapter contract present, connector unavailable

External provider execution remains provider-native. The messaging service plans and receipts operations; it does not proxy credentials or treat provider acknowledgement as verified delivery.

The exact v1.2.0 source archive, checksum, build receipt, and validation record will be attached to this branch after the controlled Slack parent-and-thread-reply proof completes.

Public Netlify deployment and live Tailscale exposure remain outside this stack and remain governed by the existing Neura decision.