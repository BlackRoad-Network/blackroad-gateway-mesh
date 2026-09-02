---
name: collaboration-control-plane
description: Coordinate Claude, ChatGPT, Codex, Roadie, and human-operated agents before connector mutations. Use for multi-agent connector work, claims, handoffs, provider-version fencing, workflow DAGs, result receipts, and timeout reconciliation.
---

# BlackRoad Collaboration Control Plane

Use this skill whenever more than one agent or runtime may touch the same connector, provider object, repository path, domain, service, task, record, deployment, or configuration.

## Do not use when

- The request is a purely local reasoning task with no shared resource.
- The operation is a read that cannot affect provider state and no workflow coordination is needed.
- The requested connector is outside the user's authorized account or infrastructure.

## Required identity

Every runtime must bind to exactly one stable identity:

```text
agent-instance-1  devices and communications
agent-instance-2  Canon and Program OS
agent-instance-3  paths, domains, DNS, names, and routing
agent-instance-4  integrations, connectors, and gateway
agent-instance-5  skills and procedures
agent-instance-6  kernel and low-level runtime
```

`ROAD_AGENT_RUNTIME` and `ROAD_AGENT_MODEL` are provenance only. They never grant authority.

## Procedure

1. Call `collaboration_register` once for the runtime session.
2. For one connector operation, call `collaboration_plan`.
3. For a multi-connector operation, call `collaboration_workflow_plan` and follow its dependency-safe waves.
4. If the plan requires a domain-owner handoff, offer it with `collaboration_handoff`. The intended recipient acknowledges it with `collaboration_ack`.
5. Do not execute a blocked plan.
6. For a permitted mutation, call `collaboration_claim` immediately before the provider-native connector call.
7. Execute the provider action through its native connector. Never route provider credentials through the collaboration daemon.
8. Capture the provider's concrete result, version, record ID, deployment ID, commit SHA, ETag, or equivalent evidence.
9. Call `collaboration_complete` only for a known terminal outcome.
10. For `TIMEOUT_UNKNOWN`, do not retry and do not close the claim as failed. Call `collaboration_reconcile`, then inspect provider state before deciding what occurred.
11. Treat a successful zero-result read as `EMPTY_OBSERVATION`, not as proof that the underlying system or resource does not exist.
12. Treat connector success as completion of one step, not completion of the overall workflow.

## Mutation requirements

A connector mutation normally requires:

- stable agent identity
- ephemeral runtime session
- canonical connector and target
- explicit operation and mode
- idempotency key
- exclusive claim
- expected provider version when supported
- provider-native authentication
- Neura decision receipt for public exposure, sensitive deployment, administration, or other governed actions
- completion receipt

## Secret boundary

Only secret references are permitted in collaboration envelopes:

```text
secretRef
secretRefs
credentialRef
```

Never place API keys, passwords, bearer tokens, cookies, private keys, or raw environment values in an operation envelope, handoff, event, or receipt.

## Conflict rules

- Same canonical resource plus two mutations means serialization, even when different runtimes requested them.
- Changed provider version means `CONFLICT`; re-read before changing anything.
- Expired claim grants no authority.
- A handoff is incomplete until the recipient acknowledges it and a completion receipt exists.
- A timeout is unresolved evidence, not a failed provider mutation.

## Validation

Success requires all applicable connector steps to have known receipts and the workflow-level validation to pass. A zero process exit code alone is insufficient.

## Implementation

```text
collaboration/daemon.mjs
collaboration/mcp-server.mjs
collaboration/dispatch.mjs
collaboration/workflow.mjs
collaboration/execution.mjs
collaboration/reconcile.mjs
```

The local service uses a private Unix-domain socket. Provider execution remains in provider-native connectors.
