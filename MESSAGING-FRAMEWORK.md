# BlackRoad Messaging Framework

Canonical service: `road://service/messaging`

Private service identity: `svc:messaging`

## Core model

```text
canonical thread
    ├── one authoritative provider/resource
    ├── normalized message references
    ├── mentions and attachment references
    ├── reactions as non-authoritative social signals
    ├── resolution state
    └── zero or more one-way provider projections
```

The messaging fabric does not make every platform a co-authoritative database. Each thread has one authority. Slack, Teams, GitHub, Linear, Asana, Notion, Airtable, and future adapters may hold projections.

## Required write sequence

```text
user approval
  → road-collab preflight
  → exclusive destination claim
  → provider-native write
  → provider read-back
  → VERIFIED receipt
  → optional addressed handoff
```

`TIMEOUT_UNKNOWN` keeps its claim and must be reconciled before retry. A reaction never satisfies user approval, governance, or code-review approval.

## Provider capability truth

Unsupported operations are returned as `UNSUPPORTED`; adapter-installed but unauthenticated platforms are `ADAPTER_AVAILABLE_CONFIG_REQUIRED`; an empty thread is `EMPTY_OBSERVATION`, not proof the provider or thread never existed.

## Mirroring

Mirrors are one-way projections with a source authority, destination resource, content hash, semantic idempotency key, lineage, and hop limit. A destination already present in lineage is blocked to prevent echo loops.
