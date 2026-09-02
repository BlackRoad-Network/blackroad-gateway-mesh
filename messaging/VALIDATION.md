# Messaging Framework Validation

Validated: 2026-09-02T18:34:24Z

## Commands

```bash
cd messaging
npm run verify
```

Result:

```text
provider capability records: 12
connected-tool providers: 6
Chat SDK provider plans: 5
JSON schemas: 5
MCP tools: 13
tests: 20
passed: 20
failed: 0
```

Additional smoke tests passed:

- CLI initialization, canonical thread creation, Slack binding, message planning, exact provider tool planning, and state doctor.
- MCP initialization, tool discovery, and `messaging_status` over newline-framed JSON-RPC.
- Atomic filesystem state persistence and append-only event journaling.
- Event hash-chain tamper detection.
- Provider-success versus read-after-write verification separation.
- `TIMEOUT_UNKNOWN` preservation.
- Exact session authority binding.
- Mirror-loop deduplication.
- Public snapshot body and provider-locator redaction.

## External effects

```text
Slack messages sent: 0
GitHub discussion comments sent by runtime tests: 0
Teams messages sent: 0
Provider credentials persisted: 0
Public deployments: 0
Tailscale mutations: 0
```
