# Messaging fabric v1.4.0 verification

Verified on 2026-09-02 from a fresh checkout of `gateway-messaging-framework-v3`.

## Results

```text
contract checker:          PASSED
Node tests:                172
passed:                    172
failed:                    0
cancelled:                 0
fresh checkout:            PASSED
staged workspace install:  PASSED
installed runtime verify:  PASSED
```

The staged installer copied the messaging runtime into a disposable workspace, created durable state outside the source tree, wrote a private install receipt, and reran the complete verifier from the installed copy.

## Exercised boundaries

- provider capability truth for twelve reviewed messaging surfaces;
- exact native argument construction for Slack, GitHub, Linear, Asana, Notion, and Airtable;
- Teams and other Chat SDK surfaces retained as configuration-required adapters;
- provider-neutral read and `COMMUNICATE` operation planning;
- exact-session collaboration intents, claims, invocations, verification, receipts, and releases;
- `TIMEOUT_UNKNOWN` claim retention and blind-retry refusal;
- provider-native read-after-write verification;
- canonical thread and message identities;
- raw-body exclusion and revision history by reference/hash;
- one-way mirror lineage, hop limits, and deduplication;
- explicit mention identity mapping and unresolved-mention preservation;
- exact-session agent subscriptions, inboxes, acknowledgement, and handoff planning;
- Slack HMAC verification and replay-window rejection;
- GitHub HMAC verification and delivery identity;
- adapter-owned verification attestations;
- inbound event deduplication, edits, deletions, reactions, and resolution;
- loopback-only HTTP ingress with bounded request bodies;
- atomic state writes, private permissions, and lock contention;
- reference-only collaboration handoff outbox;
- verified road-collab delivery completion;
- provider and collaboration timeout ambiguity;
- newline and Content-Length MCP framing;
- seven Claude launch profiles and concurrent-session separation;
- dry-run-first installer behavior;
- secret-pattern rejection and aggregate-only status output.

## Deliberately absent effects

No Slack message, Teams message, GitHub comment, Linear comment, Asana comment, Notion discussion, Airtable record comment, or other provider message was created merely to exercise the test suite.

No public messaging ingress, public Netlify deployment, Tailscale Service advertisement, Funnel route, global Claude configuration change, provider credential movement, or Neura governance bypass occurred.
