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
configuration. The HTTP server below supplies the streaming and acknowledgment
implementation. The request-intake module itself reads no environment variables,
opens no listener, and sends no response or provider request. `outcome.acknowledgement` contains the
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
is deployed by this PR. The low-level normalizer/planner remain policy utilities
for trusted host code; public request routes must use the signed-request handler.

### HTTP endpoint and durable handoff

`createSlackIngressServer` now wires the signed handler to a real Node HTTP
endpoint at `POST /slack/events`. It returns an **unbound** server; imports and
construction perform no network startup or filesystem writes. The host supplies
private app configuration and an existing owned directory with mode `0700` on a
persistent local Linux filesystem. For example, inside an explicitly started host:

```js
import { createSlackIngressServer } from './slack-http-server.mjs';
import { SlackReferenceInbox, restoreSlackInboxEvent } from './slack-reference-inbox.mjs';

const inbox = new SlackReferenceInbox({ directory: inboxDirectory });
const server = createSlackIngressServer({ signingSecret, applicationId, inbox });
server.listen(port, '127.0.0.1'); // Host-selected port; TLS ingress is configured separately.
```

The endpoint bounds actual streamed bytes, checks declared length, rejects
duplicate signing headers and compressed bodies, and limits headers to 8 KiB.
A 2.5-second deadline starts after headers arrive: incomplete bodies receive 408,
and unfinished storage receives 503. Responses close the connection and contain
only a short status or an authenticated URL challenge, never a command envelope.
Wrong paths, methods, invalid signatures, challenges, and ignored events create
no inbox record.

Every accepted command, including one awaiting approval, is stored before HTTP
200 is sent. The immutable record contains only workspace/channel IDs, the outer
provider event ID, message/thread timestamps, content hash, canonical event URI,
and receipt time. It contains no message body, command target, provider result,
credential, approval, or executable plan. This is proof of recorded intake, not
proof of completed execution.

The inbox writes private temporary files, syncs them, atomically links them into
place without overwriting an existing event key, and syncs the directory before
acknowledgment. Concurrent redelivery retains one original record. Reusing a
provider event ID with different content or thread binding fails closed. Missing,
nonprivate, corrupt, or inaccessible storage returns 503. A write can finish
after the HTTP deadline; a provider retry safely finds the existing reference.
Process interruption may leave temporary files, which inbox readers ignore.
Use owned local storage with hard-link and directory-sync support, not NFS or a
shared distributed queue. Provision and preserve the inbox directory before use.

For recovery, `inbox.list({ limit: 100, after })` returns `records` and an opaque
`nextCursor`. Re-scan from the beginning on subsequent passes to discover new
records; pagination orders keys, not receipt times. Retain the immutable records
and let RoadOS's durable claim/completion store track processing separately.
After an authenticated provider-native read of the original message:

```js
const event = restoreSlackInboxEvent(record, {
  workspaceId, channelId, message // Trusted provider read-back, not caller-supplied text.
});
```

Recovery checks the original workspace, channel, message timestamp, author,
thread, and content hash before rebuilding a process-local normalized event.
Missing, edited, deleted, or mismatched observations stay blocked for operator
review. Recovered events still need current RoadOS policy, approval, and an
exclusive durable execution claim. No dispatcher, provider reader, polling worker,
TLS proxy, live subscription registration, or production service is activated by
the HTTP server. The tests exercise actual loopback HTTP with synthetic requests.

GitHub pull-request events are classified as `OPENED`, `READY`, `UPDATED`, `MERGED`, or `CLOSED`. Unsupported actions fail closed. Delivery IDs remain traceable while semantic keys deduplicate provider redelivery of the same PR state.

The delivery planner emits exactly one of:

- `PARENT` when no canonical PR marker is recorded;
- `THREAD` with the exact existing Slack timestamp when a parent exists;
- `NOOP_DUPLICATE_*` when either the provider delivery or semantic event is already recorded.

Keys are recorded only after the provider write is read back and verified.

### Inbox worker and RoadOS broker handoff

`createSlackInboxWorker` implements the explicit inbox scan and broker handoff.
It is disabled by default; construction and `runOnce()` without `enabled: true`
perform no provider reads or broker calls. Supply an existing private `0700`
ledger directory on owned local Linux storage, separate from the reference inbox:

```js
import { SlackHandoffLedger, createSlackInboxWorker } from './slack-inbox-worker.mjs';

const worker = createSlackInboxWorker({
  inbox,
  ledger: new SlackHandoffLedger({ directory: ledgerDirectory }),
  readMessage, // Authenticated provider read-back, returning workspaceId/channelId/message.
  getState,    // Current trusted RoadOS policy, resolved plans, and bound approval.
  broker: { handoff, lookup }
});
const batch = await worker.runOnce({ enabled: true, limit: 20, after: cursor });
```

Each pending record is restored against provider read-back and evaluated through
the current command planner, including resolved-plan hashes and strong-approval
rules. Blocked plans do not consume a ledger claim, so a later approved scan can
continue. The worker freezes its plan snapshot and syncs a permanent claim before
calling the broker. Concurrent workers and restarted processes cannot submit that
event again. The ledger stores only a hashed event key and an opaque work-item
UUID; command targets, source bodies, approval records, and provider errors stay
out of it.

Broker adapter contract:

- `handoff({ event, plan, idempotencyKey })` must atomically recheck current
  session/policy/approval, acquire the exact resource claim, and durably create or
  find one work item for that key. It returns `{ accepted: true, workItemId }`
  only after durable acceptance; `workItemId` must be a lowercase UUID.
- `lookup({ idempotencyKey })` is read-only. It returns the same accepted item
  when acceptance can be proved, or an unconfirmed result otherwise.

`HANDED_OFF` means broker acceptance, not provider execution or completion.
Thrown, timed-out, invalid, rejected, or unpersisted responses leave
`HANDOFF_UNKNOWN`. Future scans use lookup only. A crash between claim creation
and submission also stays unknown and needs operator/broker reconciliation;
claims never expire and must not be deleted to retry a write. Late callbacks
cannot trigger a new submission. Read-back, state retrieval, and broker calls
each have a configurable deadline (two seconds by default); timed-out provider
requests are not cancelled. Disk operations require functioning local storage.

`runOnce` returns reference-only outcomes and the inbox pagination cursor. Re-scan
from the beginning on later passes so blocked and newly arrived items are seen.
No timer, broker backend, provider reader, or execution adapter is installed by
this module. The injected broker remains responsible for authoritative approval,
resource exclusion, provider execution, verification, and canonical receipts.

## Provider roles

| Provider | Role | Current state |
|---|---|---|
| Slack | cockpit / discussion | outbound verified; signed HTTP intake and reference inbox implemented; inbound subscription unverified |
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
