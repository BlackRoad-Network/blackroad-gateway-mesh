# Collaboration control plane

This directory contains the runtime-neutral protocol used by the six BlackRoad agents and every connector adapter.

## Verify

```bash
cd collaboration
npm run verify
```

## Components

- `core.mjs`: state transitions, claims, handoffs, receipts, result classification, redaction, and invariant checks.
- `store.mjs`: local atomic state persistence and exclusive locking.
- `cli.mjs`: command-line control surface.
- `manifest.json`: canonical service, agents, events, and invariants.
- `connector-topology.json`: explicit responsibilities across connected systems.
- `connector-policy.json`: per-provider conflict and version semantics.
- `schemas/`: protocol schemas.
- `tests/`: deterministic concurrency and safety tests.

## Runtime rule

Claude, ChatGPT, Codex, and Roadie use the same stable agent IDs and protocol. Runtime identity is recorded for provenance but never increases authority.

## Storage rule

The local filesystem adapter is the first implementation because every agent in `/Users/alexa/workspace` can use it without depending on a cloud provider. Connector-backed mirrors can be added behind the same protocol after their authority and conflict semantics are verified.
