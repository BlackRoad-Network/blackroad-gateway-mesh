# BlackRoad Messaging Stack v1.2.0

This stacked branch adds a provider-neutral discussion plane on top of `gateway-collaboration-v1` without editing Claude's collaboration core.

Canonical identities:

- `road://service/messaging`
- `road://thread/<id>`
- `road://message/<id>`

The implementation covers canonical threads, replies, edits, tombstones, reactions, provider bindings, delivery projections, exact runtime-session ownership, idempotency, timeout reconciliation, read-after-write verification, echo deduplication, public redaction, CLI access, loopback service access, and Claude-compatible MCP access.

Current observed provider posture:

- Slack: `READ_WRITE_DISCUSSION`
- GitHub: `READ_WRITE_DISCUSSION`
- Linear, Notion, Asana, Airtable: read-only discussion surfaces
- Microsoft Teams: adapter contract present, connector unavailable

External provider execution remains provider-native. The messaging service plans and receipts operations; it does not proxy credentials or treat provider acknowledgement as verified delivery.

## Verified release

- protocol: `road-messaging/1.2`
- provider capability records: 12
- observed provider surfaces: 12
- MCP tools: 15
- automated tests: 33 passed, 0 failed
- clean-extract verification: passed
- controlled Slack proof: one parent message, one native thread reply, two messages read back, bodies matched
- archive SHA-256: `852dbb261fde331c6e3149e16642c5ae4c121ec831b9d6cbdbbc54ae95a3b0bd`

Public proof preserves only provider-reference hashes and aggregate evidence. Actual workspace, channel, and message identifiers remain in the private receipt.

Release metadata, validation, build receipt, CI, and the public Slack proof are committed on this branch. The exact binary archive is retained as a verified conversation artifact rather than published into the repository.

Public Netlify deployment and live Tailscale exposure remain outside this stack and remain governed by the existing Neura decision.
