# Collaboration control-plane validation

Validated on 2026-09-02 with Node.js `v22.16.0` and npm `10.9.2`.

## Static protocol check

`npm run check` passed with:

- protocol version: `1.0`
- stable agents: `6`
- collaboration event types: `17`
- connector authority planes: `10`
- per-connector policies: `22`
- protocol schemas: `6`
- validation errors: `0`

The checker verifies the six-agent identity set, unique topology and policy IDs, mutation idempotency, timeout/zero semantics, operation-envelope requirements, JSON parsing, and secret-pattern rejection.

## Automated tests

`npm test` passed:

```text
14 tests
14 passed
0 failed
0 cancelled
0 skipped
```

Coverage includes:

- stable agent identity separated from runtime identity
- rejection of agents outside `agent-instance-1` through `agent-instance-6`
- mandatory idempotency keys for connector mutations
- same-target lease conflicts across agents
- one concurrent mutation per stable agent across runtime sessions
- replay of an identical active claim
- claim completion and append-only receipt creation
- claim expiry and safe target reclamation
- recipient-bound handoff acknowledgement
- preservation of `TIMEOUT_UNKNOWN` and `EMPTY_OBSERVATION`
- secret-material rejection
- public-status redaction
- mutation claim requirements in operation envelopes
- collaboration-state doctor checks

## End-to-end CLI proof

A temporary local collaboration state was initialized and exercised with:

- `agent-instance-4` running as `chatgpt`
- `agent-instance-3` running as `claude`
- one GitHub target claim
- one successful operation receipt
- one cross-agent handoff
- recipient acknowledgement and completion

Final doctor state:

```json
{
  "sessions": 2,
  "activeSessions": 2,
  "claims": 1,
  "activeClaims": 0,
  "handoffs": 1,
  "offeredHandoffs": 0,
  "receipts": 1,
  "events": 7
}
```

The public status contained agent/runtime provenance and aggregate counts but omitted connector target references and private handoff payloads.

## Deployment boundary

This validation covers the local collaboration protocol and CLI. It does not claim:

- public Netlify deployment
- Tailscale Service activation
- Neura Registry registration
- provider-side record mirroring
- modification of ChatGPT plugin permissions

The existing Neura STOP decision remains in force for public deployment.
