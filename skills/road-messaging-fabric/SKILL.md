---
name: road-messaging-fabric
version: 1.0.0
description: Plan and coordinate threaded comments, replies, reactions, edits, resolution, and one-way cross-provider mirrors across Slack, GitHub, Linear, Asana, Notion, Airtable, Teams, and other reviewed chat adapters. Use when an agent needs discussion or messaging behavior. Do not use to bypass provider authentication, user approval, collaboration claims, or governance.
---

# Road Messaging Fabric

## Activate when

- an agent needs to read or create a provider discussion;
- a comment or reply must be mirrored to another approved provider;
- a provider timeout leaves message delivery ambiguous;
- a mention, reaction, edit, deletion, or thread-resolution action needs normalized semantics.

## Required procedure

1. Resolve the provider capability and canonical `road+message://` resource.
2. For reads, record an observation when downstream work depends on it.
3. For any write, classify it as `COMMUNICATE` and require explicit user-approval evidence.
4. Register the exact live runtime session in `road-collab`.
5. Acquire the exclusive destination claim with a semantic idempotency key.
6. Execute only the provider-native tool named by the operation plan.
7. Preserve `TIMEOUT_UNKNOWN`; do not retry until provider read-back resolves the effect.
8. Read the destination thread or message back.
9. Record `VERIFIED` evidence, then create the receipt.
10. Publish an addressed handoff when another agent owns the next action.

## Hard boundaries

- Never infer a provider account, channel, recipient, issue, page, task, or record ID.
- Never place provider credentials or raw secret-bearing content into collaboration state.
- Never treat reactions as authorization.
- Never enable bidirectional mirroring by default.
- Never call provider success complete before read-after-write verification.
- Never convert zero results to nonexistence or a timeout to failure.

## Completion evidence

A successful messaging mutation includes the exact agent/session, connector, canonical destination, operation, idempotency key, provider request reference when available, provider-native read-back reference, and a receipt asserting that neither secret values nor message bodies were persisted in the public collaboration ledger.
