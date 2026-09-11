# Slack orchestration cockpit

Slack is the temporary live cockpit for BlackRoad orchestration. RoadOS remains the canonical authority, policy, identity, workflow, and receipt layer.

## Topology

```text
Alexa / agents
      |
      v
Slack #agent-hub
      |
      v
Roadie intent + policy + claim
      |
      +--> GitHub provider adapter
      |
      +--> Tailscale private transport --> Ollama worker
      |
      +--> other provider-native connectors
      |
      v
read-after-write verification --> RoadOS receipt --> Slack thread
```

## Exact live bindings

- Workspace: `road+connector://slack/workspace/T09BC6BSEDV`
- Cockpit space: `road+connector://slack/channel/C0A2M4K8WLB` (`#agent-hub`)
- Canvas: `road+connector://slack/canvas/F0C0GUEDXL6`
- GitHub integration repository: `road+connector://github/repository/BlackRoad-Network/blackroad-gateway-mesh`
- Model route: `road://service/models`
- Tailscale service: `svc:models`
- Ollama listener candidate: `127.0.0.1:11434`

The Slack kickoff message was read back successfully at provider message ID `1788943756.716919`.

## Command grammar

One operation belongs to one Slack parent message and thread.

- `road status <target>`
- `road plan <goal>`
- `road run <approved-plan>`
- `road verify <operation>`
- `road receipt <operation>`
- `road stop <operation>`
- `road reconcile <operation>`
- `road handoff <owner> <operation>`

Commands are normalized into the existing collaboration intent, invocation, verification, handoff, and receipt schemas. This directory does not replace those contracts.

The command-intake planner is now executable policy. It deduplicates by canonical event ID, preserves Slack's exact thread timestamp, and binds approval to the command event, non-secret content hash, and thread. Reads can become dispatch-ready only after inbound subscription evidence is supplied. Mutating commands require a matching approval; high-risk targets require a matching strong approval. Intake itself performs no provider mutation, and the command is recorded only after a verified receipt.

Secret-like material is rejected before a command target can enter the normalized envelope. Slack is never a place to paste tokens, passwords, private keys, or bearer credentials.

### Authenticated request intake

`slack-request-intake.mjs` implements the HTTP Events API request boundary as a
host-callable handler. It follows [Slack's signing protocol](https://docs.slack.dev/authentication/verifying-requests-from-slack/):
HMAC-SHA256 over the version, timestamp, and original body bytes, compared using
`timingSafeEqual`, with a five-minute timestamp window. It rejects malformed or
duplicate signing headers, oversized bodies, invalid UTF-8/JSON, and wrong app or
workspace bindings before normalizing a command. The local test includes Slack's
published signing example; it does not use a live app credential.

```js
import { createSlackRequestIntake } from './slack-request-intake.mjs';

// Values come from the host's private configuration; never from Slack messages.
const intake = createSlackRequestIntake({ signingSecret, applicationId });
const outcome = intake.handle({
  method: request.method,
  headers: request.headers,
  rawBody // Buffer or Uint8Array, collected with a byte limit before JSON parsing
}, trustedCockpitState);
```

The host must cap the HTTP stream while reading it (64 KiB by default), preserve
the exact bytes, and supply its app ID and signing secret through private
configuration. This module reads no environment variables, opens no listener,
and sends no response or provider request. `outcome.acknowledgement` contains the
suggested HTTP status and plain-text response body; never send the full outcome
back to Slack. Authenticated [URL challenges](https://docs.slack.dev/reference/events/url_verification/)
return only the challenge and cannot become commands.

Only ordinary `message` callbacks from the configured workspace, cockpit channel,
and operator are eligible. Edits, deletes, broadcasts, file shares, bot events,
and other event types do not create new commands. Identity comes from the signed
outer event ID plus the validated message fields. A request authenticates its
source; it does not establish that the subscription remains enabled or grant any
execution approval. Payload fields claiming approval are ignored. Approval and
deduplication state come exclusively from `trustedCockpitState` supplied by RoadOS.

Per [Slack's Events API guidance](https://docs.slack.dev/apis/events-api/), the
host must acknowledge accepted events promptly and hand work to its own durable
queue before acknowledging. The returned event/plan contains the command target
for private, transient use; it is not a public receipt and must not be logged
wholesale. Persist only appropriate references, hashes, and ownership evidence in
canonical state. Provider execution still requires RoadOS intent, capability,
exclusive claim, semantic idempotency, and read-after-write verification.

The five-minute timestamp window is not exactly-once delivery. Repeated signed
requests within that window may be planned again until the host records the
canonical event ID; the host's durable claim prevents concurrent execution.
Normalized events are deeply frozen and recognized only in the process that
created them. `planSlackCommandIntake` rejects forged or JSON-cloned envelopes.
After restart, re-normalize a trusted source observation before replanning; do
not treat a deserialized object or a boolean field as request authentication.

The live inbound subscription remains unverified, and no endpoint or scheduler
is installed by this PR. The low-level normalizer/planner remain policy utilities
for trusted host code; public request routes must use the signed-request handler.

GitHub pull-request events are classified as `OPENED`, `READY`, `UPDATED`, `MERGED`, or `CLOSED`. Unsupported actions fail closed. Delivery IDs remain traceable while semantic keys deduplicate provider redelivery of the same PR state.

The delivery planner emits exactly one of:

- `PARENT` when no canonical PR marker is recorded;
- `THREAD` with the exact existing Slack timestamp when a parent exists;
- `NOOP_DUPLICATE_*` when either the provider delivery or semantic event is already recorded.

Keys are recorded only after the provider write is read back and verified.

## Provider roles

| Provider | Role | Current state |
|---|---|---|
| Slack | cockpit / discussion | outbound verified; signed request intake and command planner implemented; inbound subscription unverified |
| GitHub | code + PR event source | event route enabled for this repository |
| Tailscale | private service transport | contract defined; live tailnet state not observed in this connector session |
| Ollama | private model worker | blocked until a node, listener, model inventory, and bounded inference are verified |
| Roadie | orchestrator | selects an allowed connector/worker; never hard-codes authority |
| Forgejo/Gitea | canonical source target | GitHub may transport or mirror; it does not replace `git.blackroad.systems` |
| 1Password | secret reference | values never enter Slack, GitHub, or receipts |

## Safety invariants

1. Unknown commands and connectors fail restrictive.
2. Slack message authorship is not sufficient authority for high-risk actions.
3. Reads may run automatically.
4. Writes require exact target and explicit execution intent.
5. Destructive, administrative, financial, secret, identity, access-control, merge, deploy, and public-exposure actions require stronger reviewed approval.
6. Tailscale uses grants, tailnet-only visibility, and no implicit Funnel.
7. Ollama never silently falls back to a public or paid model.
8. Provider acknowledgement is not success. Mutations require provider-native read-back.
9. `TIMEOUT_UNKNOWN` is reconciled before retry.
10. Secrets and sensitive prompt bodies are excluded from logs and receipts.

## Verification

Run from this repository:

```bash
node --test orchestration/*.test.mjs
```

This verifies the public-safe manifest, signed request intake, and routing policy
with local fixtures. It does not claim a live Slack subscription, Tailscale node,
or Ollama process exists.
