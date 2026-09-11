<!-- BlackRoad SEO Enhanced -->

# BlackRoad gateway mesh

> Part of **[BlackRoad OS](https://blackroad.io)** — Sovereign Computing for Everyone

[![BlackRoad OS](https://img.shields.io/badge/BlackRoad-OS-ff1d6c?style=for-the-badge)](https://blackroad.io)
[![BlackRoad-Network](https://img.shields.io/badge/Org-BlackRoad-Network-2979ff?style=for-the-badge)](https://github.com/BlackRoad-Network)

**BlackRoad gateway mesh** is the provider-neutral connector control plane for the BlackRoad OS ecosystem.

## Connector Fabric

The executable v1.10.0 registry defines 65 connector contracts. It separates each connector's architectural role from its observed account state, then applies one fail-closed planner to every proposed read or mutation.

- Roles: `discussion`, `delivery`, `event`, `control`, `decision`, and `reference-only`.
- States: `ready`, `ready-empty`, `limited`, `broken`, `unverified`, `unavailable`, and `policy-only`.
- Provider aliases share one authenticated control plane without losing distinct contract identities.
- Mutations require ownership, exclusive claim, idempotency, authentication, verification, approval, and—where applicable—governance evidence.
- No tokens, cookies, account identifiers, message contents, or other secrets belong in the registry.

### Commands

```bash
node bin/road-connectors.mjs check
node bin/road-connectors.mjs status
node bin/road-connectors.mjs list
node bin/road-connectors.mjs describe slack
node bin/road-connectors.mjs audit --concurrency=4
node bin/road-connectors.mjs route billing read
node bin/road-connectors.mjs route email-delivery write --preferred=gmail
node bin/road-connectors.mjs native status
node bin/road-connectors.mjs native describe outlook-email
node bin/road-connectors.mjs native plan cloudflare
node bin/road-connectors.mjs apps status
node bin/road-connectors.mjs apps describe github
node bin/road-connectors.mjs plan github read
node bin/road-connectors.mjs plan slack write --evidence=explicit-user-approval
node --test test/*.test.mjs
```

`plan` reports every missing precondition. Supplying one evidence flag never implies the others.

### Adding or repairing a connector

1. Add exactly one canonical role in `data/connector-fabric.json`.
2. Add an observation only after a harmless account-backed read; otherwise leave it `policy-only`.
3. Use `providerAliases` only when the alias truly shares the target's authentication and health.
4. Keep event connectors read-only and reference-only connectors non-executable.
5. Add a regression test, run `check`, and run the complete test suite.

Provider-specific adapters sit behind this contract. A successful adapter call does not count as a successful mutation until the provider is read back and the intended state is verified.

## Native replacements

Every external connector maps to exactly one owned capability inside the eight RoadOS surfaces: Search, Chat, Code, Work, Play, Design, Integrate, and Collaborate. The native exit gate requires owned storage, local behavior, provider-neutral import/export, disconnect, rollback, and receipts before a capability can become native-preferred. See [NATIVE-REPLACEMENTS.md](NATIVE-REPLACEMENTS.md).

## Adapter runtime

`ConnectorRuntime` accepts adapters by canonical connector id or shared provider alias. Execution is dry-run by default. Live execution remains blocked unless the planner accepts every required evidence field, an adapter is registered, and writes pass provider read-after-write verification.

Write evidence is never accepted as caller-supplied booleans. Every evidence record must be bound to the principal, live session, connector, operation, and canonical input digest; it must carry a trusted issuer, bounded validity window, unique nonce, and proof accepted by an injected `EvidenceVerifier`. The runtime consumes valid nonces atomically before execution so a concurrent retry cannot replay approval.

Receipts contain an SHA-256 digest of the input instead of the input itself, so tokens, message bodies, and account data are not copied into logs.

Write exceptions, including timeouts and exceptions during read-back, produce
`status: "unknown"` with `reconciliation: { required: true, automaticRetry: false }`.
Any successful invocation result remains on the returned outcome for subsequent
provider read-back; it is not copied into the receipt. Approval nonces remain
consumed. A timeout does not cancel or roll back a provider request.

The optional `DurableReconciliationQueue` records intent before provider dispatch
and schedules separate read-backs. Without a queue, the calling orchestrator must
retain unknown receipts and arrange those read-backs. A completed immediate
read-back returning `ok: false` retains the existing failed-verification status;
read execution errors remain failed reads.

### Durable reconciliation

Import `DurableReconciliationQueue` from `./src/reconciliation.mjs` (or the package's
`/reconciliation` export). Configure it on the runtime and invoke its worker from
your trusted service's timer:

```js
const queue = new DurableReconciliationQueue({ directory: '/var/lib/road/reconciliation' });
const runtime = new ConnectorRuntime({ adapters, evidenceVerifier, reconciliationQueue: queue });

// The host supplies a durable private contextStore and trusted write evidence.
// Reuse this UUID when resuming the same operation; never generate a new one for a retry.
const contextKey = crypto.randomUUID();
await contextStore.put(contextKey, { id: 'slack', input });
const outcome = await runtime.execute({
  id: 'slack', operation: 'write', input, evidence, principal, sessionId,
  contextKey, dryRun: false
});
if (outcome.result !== undefined) {
  await contextStore.put(contextKey, { id: 'slack', input, result: outcome.result });
}

// Call periodically; each invocation handles at most 20 due jobs by default.
const updates = await queue.runDue({
  adapters,
  resolveContext: (key) => contextStore.get(key)
});
for (const job of updates) {
  if (job.receipt) receiptChain.append(job.receipt);
}
```

The host must persist the original target/idempotency context before dispatch.
An adapter must be able to find the write using that context if the response or
its provider reference was lost. The worker checks the resolved connector and
input hash before calling only `adapter.verify`; it never invokes `execute` or
consumes approval. A missing context can retry; a mismatched context goes to
manual review. Only literal `ok: true` confirms success. Negative responses and
exceptions retry with exponential delay, then stop at `manual-review` without
asserting that the write failed. Inspect `queue.list()` for all retained jobs and
receipts, including completions whose caller exited before collecting them.

Defaults: 30 seconds of initial grace for interrupted dispatch, 5 seconds per
read-back (including context resolution), 30 seconds initial retry delay, five
attempts, and a one-day maximum delay. Configure grace to accommodate expected
write duration. Expired worker leases recover after process exit; late results
cannot overwrite a newer lease or terminal outcome. Timeouts do not cancel
in-flight provider requests, so repeated **reads** can overlap after lease expiry.

Jobs use private files, atomic replacement, file/directory sync, and exclusive
locks around short disk transactions. Run on an owned, persistent local Linux
filesystem; this is not a distributed or network-filesystem queue. If a process
dies during a disk transaction, its `.lock` deliberately fails closed: stop all
queue users and establish that no owner remains before removing that lock and
restarting. Do not remove job JSON files to retry a write. Their UUID reservations
prevent reuse across runtime restarts, including with fresh approval. The existing
evidence nonce cache remains process-local; this is not a global exactly-once
guarantee, and new operation keys still require the planner's trusted evidence.

Queue files contain connector IDs, opaque UUIDs, input hashes, schedule/history,
and redacted completion receipts. Keep the context store, provider credentials,
and receipt-chain checkpoints in host-managed storage. Unknown runtime receipts
include `reconciliation.jobId`; queue reservation failures block dispatch and
post-dispatch persistence failures remain unknown. A configured queue requires a
context UUID for every actual write; dry runs do not create jobs. Importing the
module starts no timer or provider activity. No scheduler service is deployed by
this package.

## Adapter SDK and fleet audit

`defineAdapter` rejects malformed adapters and requires every write-capable adapter to provide a verification function. `AdapterRegistry` rejects duplicate registrations and declared IDs that differ from their registration keys. Provider aliases can still resolve a canonical connector through its correctly registered shared adapter.

`auditConnectors` probes a selected set or all 65 connectors with bounded concurrency from 1–16, while preserving canonical result order. `diffHealthSnapshots` classifies recovery, degradation, and same-health state changes. With no live adapters registered, the CLI audit reads the verified catalog overlay and performs no network calls.

`ReceiptChain` creates a SHA-256-linked sequence of execution receipts. Its verifier detects modification, insertion, or reordering; checking against an externally retained `checkpoint()` also detects tail deletion. Raw request inputs are never stored in the chain.

## Semantic routing and MCP bridge

Routing profiles map outcomes such as collaboration, email delivery, document signing, scheduling, deployment, analytics, meetings, billing, and secrets to eligible connectors. Read routes may select the first healthy equivalent. Write routes require an explicit provider selection and never silently fail over.

`source-of-truth` routes cannot substitute providers: broken Stripe remains a blocked billing route. `reference-only` routes cannot execute: 1Password remains a secret reference boundary.

`createMcpAdapter` converts an injected MCP invoker and declarative tool map into a conforming adapter. Read operations can retry transient failures; writes receive exactly one attempt. Timeouts and circuit breaking prevent a failing provider from consuming the entire connector worker pool.

## BlackRoad Ecosystem

| Org | Focus |
|---|---|
| [BlackRoad OS](https://github.com/BlackRoad-OS) | Core platform |
| [BlackRoad OS, Inc.](https://github.com/BlackRoad-OS-Inc) | Corporate |
| [BlackRoad AI](https://github.com/BlackRoad-AI) | AI/ML |
| [BlackRoad Hardware](https://github.com/BlackRoad-Hardware) | Edge hardware |
| [BlackRoad Security](https://github.com/BlackRoad-Security) | Cybersecurity |
| [BlackRoad Quantum](https://github.com/BlackRoad-Quantum) | Quantum computing |
| [BlackRoad Agents](https://github.com/BlackRoad-Agents) | AI agents |
| [BlackRoad Network](https://github.com/BlackRoad-Network) | Mesh networking |

**Website**: [blackroad.io](https://blackroad.io) | **Chat**: [chat.blackroad.io](https://chat.blackroad.io) | **Search**: [search.blackroad.io](https://search.blackroad.io)

## Getting Started

```bash
git clone https://github.com/BlackRoad-Network/blackroad-gateway-mesh.git
cd blackroad-gateway-mesh
```

## License

Proprietary — BlackRoad OS, Inc. All rights reserved.

---

*BlackRoad OS — Remember the Road. Pave Tomorrow.*
