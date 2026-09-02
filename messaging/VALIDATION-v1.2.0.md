# Messaging Framework Validation v1.2.0

Validated on 2026-09-02 with Node.js 22.

## Verification

```bash
cd messaging
npm run verify
```

The release package was then archived, extracted into a clean directory, and the same full verifier was run again from the clean extract.

```text
protocol: road-messaging/1.2
provider capability records: 12
observed provider surfaces: 12
connected-tool providers: 6
writable observed providers: 2
read-only observed providers: 4
Chat SDK provider plans: 5
JSON schemas: 7
MCP tools: 15
tests: 33
passed: 33
failed: 0
skipped: 0
clean-extract verification: PASS
```

Archive:

```text
blackroad-messaging-framework-v1.2.0.tar.gz
SHA-256: 852dbb261fde331c6e3149e16642c5ae4c121ec831b9d6cbdbbc54ae95a3b0bd
```

## Covered behavior

- canonical spaces, threads, comments, replies, edits, tombstones, reactions, read markers, and resolution states;
- semantic idempotency and optimistic thread-version fencing;
- one authoritative provider binding per canonical discussion;
- exact runtime-session ownership for external communication;
- collaboration intent, claim, approval, request-hash, provider invocation, read-back verification, and receipt requirements;
- Slack channel, thread, reply, edit, delete, reaction, upload, draft, schedule, canvas, and conversation-creation surface planning;
- GitHub issue, pull-request, and review-thread comment planning;
- Linear, Notion, Asana, and Airtable discussion-read planning without invented write authority;
- Microsoft Teams adapter planning while truthfully preserving `NOT_CONNECTED`;
- provider acknowledgement versus verified delivery;
- `TIMEOUT_UNKNOWN` preservation and evidence-based reconciliation;
- inbound echo deduplication and bridge-loop prevention;
- public locator/body redaction;
- atomic filesystem state and event-chain tamper detection;
- newline and Content-Length MCP framing;
- local loopback HTTP service behavior.

## Controlled live proof

A Slack parent message and one native thread reply were posted to the BlackRoad engineering collaboration channel, then read back as a complete two-message thread. The message bodies matched. Public proof contains hashes and aggregate counts; real Slack identifiers remain only in the private receipt.

## External-effects boundary

```text
Slack messages sent in controlled proof: 2
GitHub comments sent by automated tests: 0
Teams messages sent: 0
Provider records mutated by automated tests: 0
Provider credentials persisted: 0
Public deployments: 0
Tailscale mutations: 0
Neura STOP decisions bypassed: 0
```
