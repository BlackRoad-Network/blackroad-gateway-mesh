---
name: road-messaging-framework
version: 1.0.0
description: Coordinate comments, threads, replies, mentions, reactions, and discussion mirrors across BlackRoad agents and connected providers. Use when work needs a durable conversation spanning Slack, Teams, GitHub, Linear, Asana, Notion, Airtable, or another messaging adapter. Do not use for one isolated read with no downstream discussion state.
---

# Road Messaging Framework

## Activate when

- two agents must discuss or acknowledge the same resource;
- a provider comment or thread must be represented in BlackRoad;
- a Slack, Teams, GitHub, Linear, Asana, Notion, or Airtable discussion needs a canonical Road identity;
- a message must be projected to another provider;
- a provider timeout could have produced an ambiguous communication;
- a comment needs read-after-write verification;
- mentions, reactions, resolution, or handoffs are part of the workflow.

## Do not activate when

- the task is a single read-only lookup with no conversation state;
- the user only wants prose drafted and not connected to a destination;
- the operation is email delivery without discussion semantics;
- the provider surface is not known and no safe discovery can be performed.

## Required inputs

- stable acting agent identity;
- exact live session reference;
- canonical thread or resource identity;
- provider binding when a provider is involved;
- message body or reaction;
- idempotency key;
- expected thread version for mutations;
- user approval reference for external communication.

## Procedure

1. Inspect `road://service/collaboration` state.
2. Resolve the canonical Road thread or create an internal thread.
3. Bind provider conversations without posting.
4. Classify the action as READ, COMMUNICATE, or WRITE.
5. Obtain the collaboration claim and required approval/governance evidence.
6. Plan the provider-native operation.
7. Execute through the provider-native connector or Chat SDK adapter.
8. Record the provider outcome.
9. Read the provider thread back.
10. Verify the exact message, author, body hash, and provider version.
11. Record the final receipt.
12. Publish an addressed handoff when another agent owns the next step.

## Invariants

- provider authentication is not communication authority;
- one canonical thread may have many provider bindings;
- only one binding is authoritative;
- bidirectional mirrors are disabled by default;
- mirror echoes never create duplicate canonical messages;
- provider success is unverified until read-back;
- timeouts remain `TIMEOUT_UNKNOWN`;
- external communication requires user approval;
- provider identifiers and message bodies stay outside public metadata;
- secrets never enter thread, message, event, handoff, or receipt metadata.

## Completion

The operation is complete only when the canonical message and all required provider projections have truthful final states, verification evidence exists for successful writes, uncertainty remains explicit, and the collaboration receipt is durable.
