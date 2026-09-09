# BlackRoad Messaging v1.9.0 — All-Connector Fabric

Status: verified in clean extraction. This child branch is based on the current `gateway-messaging-v1` head and publishes only public-safe connector collaboration contracts.

## Verified release

- 62 canonical connector contracts
- 8 native discussion adapters
- 6 native delivery adapters
- 9 read/event adapters
- 37 control-plane adapters
- 1 decision-gate adapter
- 1 reference-only secret adapter
- 26 JSON schemas
- 31 JavaScript modules
- 71 Claude MCP tools
- 50 semantic messaging evaluation families
- 118 tests passed, 0 failed

## Connector roles

Every canonical connector is exactly one of: `discussion`, `delivery`, `event`, `control`, `decision`, or `reference-only`. Unknown future connectors fail restrictive.

Discussion and delivery mutations require an exact live session, target ownership, semantic idempotency, an exclusive collaboration claim, provider-native authentication, explicit user approval, and read-after-write verification. Control/decision mutations additionally require governance evidence. Secret values never enter the fabric.

## Exact executable artifact

Private Google Drive artifact: `blackroad-messaging-framework-v1.9.0.tar.gz`

SHA-256: `95c73e62d683d6e2024a04b56da715305566c75d9b07b0c045b43b3820a3e697`

The archive was extracted into a clean directory and `npm run verify` passed with all 118 tests green.

## Safety boundary

No external provider message, comment, payment, deployment, DNS change, signature request, calendar invitation, or secret transfer was executed during verification. Public Netlify deployment remains blocked by the existing Neura STOP decision.
