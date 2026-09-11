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

The calling orchestrator must retain the unknown receipt and arrange a separate
provider read-back using the original target/idempotency context and any returned
provider object reference. It must append the reconciliation evidence before
deciding whether any new write is appropriate. This runtime does not implement a
durable reconciliation queue or schedule background provider calls. A completed
read-back returning `ok: false` retains the existing failed-verification status;
read execution errors remain failed reads.

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
