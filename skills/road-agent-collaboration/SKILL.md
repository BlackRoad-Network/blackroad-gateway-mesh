---
name: road-agent-collaboration
version: 1.0.0
description: Coordinate multiple BlackRoad agents and connector calls through durable intents, claims, sessions, invocations, verification, handoffs, and receipts. Use when two or more agents or connectors could touch related provider or repository state, when Claude and the connector orchestrator are working concurrently, or when a cross-provider workflow needs causality and conflict prevention. Do not use for a single isolated read-only lookup with no shared mutable state.
---

# Road Agent Collaboration

## Activation Contract

Activate when any of these are true:

- two or more BlackRoad agents may touch the same repository, provider object, domain, deployment, account, or service;
- Claude is using connected tools while another agent or the connector orchestrator is active;
- a provider mutation must be coordinated with another provider mutation;
- a handoff must transfer verified evidence or ownership;
- a connector call may be retried, time out, or produce ambiguous side effects;
- a write depends on a prior observation and stale data would be dangerous.

Do not activate for a one-shot metadata read that cannot mutate shared state and has no downstream dependency. Do not use this Skill as a substitute for provider-native authentication, user approval, Neura governance, or the specialist skill that actually performs the domain operation.

## Situation Classification

Classify the operation before acting:

1. `OBSERVE`: metadata or health evidence only.
2. `READ`: provider data retrieval with no mutation.
3. `WRITE`: ordinary provider or repository mutation.
4. `COMMUNICATE`: message, email, invitation, or externally visible communication.
5. `DEPLOY`: deployment, promotion, release, or runtime activation.
6. `ADMIN`: identity, security, policy, DNS, billing, account, or infrastructure administration.
7. `SECRET`: operation requiring secret material or secret-plane access.
8. `PUBLIC_EXPOSE`: action that makes a service, endpoint, site, or data publicly reachable.

Also classify whether the target is shared, whether another agent owns it, whether an observed version exists, and whether the action participates in a multi-connector workflow.

## Decision Model

- Reads may overlap unless a provider contract says otherwise.
- Mutations require a durable intent, explicit target owner, idempotency key, and exclusive claim.
- A mutating intent based on a known resource version must carry `expectedResourceVersionRef`; reject the mutation if the shared resource version changed.
- Logical agent identity and runtime session are separate. Record a heartbeat with a session reference before connector work.
- A provider tool call is a first-class invocation. Record its request hash before execution and provider request/effect references afterward.
- A successful mutation is not complete until read-after-write verification records `VERIFIED` with evidence.
- `TIMEOUT_UNKNOWN` remains unknown until fresh evidence resolves it.
- Cross-connector operations use a workflow and explicit dependency edges. Compensation is its own intent linked by `compensationForIntentId`.
- If the target belongs to another agent, hand off rather than silently assuming ownership.

## Execution Protocol

### Stage 1: Establish presence
Record heartbeat with agent ID, runtime, provider, and session reference.

### Stage 2: Observe shared state
Read collaboration summary and target claims/resources. Stop on conflicting exclusive claims.

### Stage 3: Create workflow when needed
For multi-provider or multi-agent work, create one workflow with durable idempotency and named participants.

### Stage 4: Declare intent
Include connector, action class, resource key, target owner, summary, expected outcome, idempotency key, dependencies, approval/governance refs, capability refs, and expected resource version where known.

### Stage 5: Satisfy gates and claim
Obtain required participant, governance, and user-approval evidence, then acquire the shared or exclusive claim.

### Stage 6: Start durable invocation
Mark intent executing and register `invocation.start` with tool name, session reference, and safe request hash.

### Stage 7: Execute provider-native operation
Use the specialist provider tool directly. Collaboration coordinates but does not proxy credentials.

### Stage 8: Finish invocation
Record provider outcome, opaque request ref, safe response hash, and effect refs. Mutating success moves to `VERIFYING`.

### Stage 9: Verify effects
Read the affected provider resource back and record verification evidence plus observed stable version where available.

### Stage 10: Receipt and handoff
Only after required verification may a successful mutation receive a `SUCCEEDED` receipt. Publish any required addressed handoff.

## Failure Taxonomy

- `resource-already-claimed`
- `agent-exclusive-mutation-limit`
- `resource_version_conflict`
- `idempotency_key_conflict`
- `invocation_request_conflict`
- `TIMEOUT_UNKNOWN`
- `VERIFICATION_FAILED`
- `BLOCKED_GOVERNANCE`
- `BLOCKED_USER_APPROVAL`
- `handoff_target_denied`
- `state_contention`

## Invariants

- Agent identity is not model provider.
- Session identity is not logical agent identity.
- Connector authentication is not action authority.
- Provider write success is not verified completion.
- No secret value enters collaboration state, events, receipts, or handoffs.
- One resource has at most one active exclusive mutation claim.
- One logical agent has at most one active exclusive mutation.
- Every provider mutation is idempotent and causally attributable.
- Timeouts remain unknown until evidence resolves them.
- Cross-connector dependencies are explicit.
- Provider execution remains provider-native.
- Public exposure and sensitive administration retain separate governance gates.

## Invalid Shortcuts

Reject calling the provider before registering intent/claim/invocation, treating provider success as proof of final state, retrying changed requests under an old idempotency identity, accepting stale versions, collapsing concurrent sessions, flattening timeouts, hiding compensation in prose, putting credentials in collaboration state, or bypassing coordination because an app permission is broad.

## Handoff Contract

Include source/destination agent IDs, workflow/intent refs, resource key, connector ID, proven facts, artifacts, evidence, current resource version when available, unresolved blocker/next action, and active-claim state. The recipient acknowledges before assuming responsibility.

## Completion Criteria

Collaborative connector work is complete only when the correct session is registered, mutations have durable intents and claims, provider invocations have stable request identity, successful mutations have read-after-write proof, receipts preserve the true outcome, downstream dependencies refresh, handoffs are addressed/acknowledged, collaboration validation passes, and no secret-like value entered the ledger.
