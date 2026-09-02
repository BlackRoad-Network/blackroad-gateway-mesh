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

Use these rules:

- Reads may overlap unless a provider contract says otherwise.
- Mutations require a durable intent, explicit target owner, idempotency key, exact live runtime session, stable non-secret request hash at invocation time, and exclusive claim.
- A mutating intent based on a known resource version must carry `expectedResourceVersionRef`; reject the mutation if the shared resource version changed.
- The logical agent identity and the runtime session are separate. Record a heartbeat with a session reference before connector work so two Claude sessions are not collapsed into one phantom actor.
- A provider tool call is a first-class invocation. Record its request hash before execution and its provider request reference or opaque effect reference afterward.
- A successful mutation is not complete until read-after-write verification records `VERIFIED` with evidence.
- `TIMEOUT_UNKNOWN` remains unknown. Never rewrite it as failed or successful without fresh evidence.
- Cross-connector operations use a workflow and explicit dependency edges. Compensation is represented as its own intent linked by `compensationForIntentId`, not hidden in prose.
- If the target belongs to another agent, hand off rather than silently assuming ownership.
- If a connector has no explicit collaboration rule, default to readable discovery but restrict mutation to the connector orchestrator/agent 4 steward plane; all unknown-connector mutation classes require governance, explicit user approval, and steward participation.

## Execution Protocol

### Stage 1: Establish presence

Record a heartbeat containing agent ID, runtime, provider, and session reference. Exit when the session is visible and current.

### Stage 2: Observe shared state

Read the collaboration summary and the current resource/claim state. If another exclusive claim exists for the target, stop and publish or consume a conflict rather than racing it.

### Stage 3: Create workflow when needed

For multi-provider or multi-agent work, create one workflow with a durable idempotency key, one integration owner, named participants, and a delegation-contract reference when work is parallelized. Each operation becomes an intent under that workflow.

### Stage 4: Declare intent

Create the intent with connector, action class, resource key, target owner, summary, expected outcome, idempotency key, dependencies, governance/user-approval references, capability references, and expected resource version when known.

### Stage 5: Satisfy gates and claim

Required participants approve from live runtime sessions. Governance and user-approval gates must be present where required. Acquire the shared or exclusive claim only when the intent is ready. An exclusive claim is session-owned; only that session may renew or release it unless the collaboration broker performs an explicit recovery action.

### Stage 6: Start durable invocation

Mark the intent executing, then register `invocation.start` with the provider tool name, session reference, and hash of the provider request shape. Never place secret values in collaboration state.

### Stage 7: Execute provider-native operation

Use the specialist provider tool directly. The collaboration layer coordinates the action but does not proxy provider credentials.

### Stage 8: Finish invocation

Record provider outcome, opaque request reference, response hash if safe, and effect references. A mutating provider success transitions to `VERIFYING`, not directly to success.

### Stage 9: Verify effects

Read the affected provider resource through the provider-native read surface. Record `verification.record` with evidence and the observed stable version reference where the provider exposes one.

### Stage 10: Receipt and handoff

Only after required verification may a successful mutation receive a `SUCCEEDED` receipt. Complete or publish any handoff with artifact/evidence references. Downstream intents then re-evaluate their dependency state.

## Failure Taxonomy

- `resource-already-claimed`: another agent owns the active mutation lease.
- `agent-exclusive-mutation-limit`: the same agent already has another active exclusive mutation.
- `resource_version_conflict`: a stale read attempted to authorize a write.
- `idempotency_key_conflict`: a key was reused for a different operation.
- `invocation_request_conflict`: an invocation retry changed its request hash.
- `TIMEOUT_UNKNOWN`: provider completion could not be determined.
- `VERIFICATION_FAILED`: the read-back did not prove the intended effect.
- `BLOCKED_GOVERNANCE`: required Neura or equivalent governance evidence is absent.
- `BLOCKED_USER_APPROVAL`: an externally consequential action lacks required user authorization evidence.
- `handoff_target_denied`: an agent attempted to bypass the allowed collaboration graph.
- `state_contention`: the shared broker state changed too frequently; retry with the same semantic idempotency key and a fresh transport nonce.

## Invariants

- Agent identity is not the model provider.
- Session identity is not the logical agent identity.
- Connector authentication is not action authority.
- Provider write success is not verified completion.
- No secret value enters collaboration state, events, receipts, or handoffs.
- One resource has at most one active exclusive mutation claim.
- Every mutation intent, claim, claim renewal/release, execution, invocation, verification, and receipt remains bound to the exact live runtime session that owns the intent.
- One logical agent has at most one active exclusive mutation.
- Every provider mutation is idempotent and causally attributable.
- Timeouts remain unknown until evidence resolves them.
- Cross-connector dependencies are explicit.
- Provider execution remains provider-native.
- Public exposure and sensitive administration retain their separate governance gates.

## Invalid Shortcuts

Reject these shortcuts:

- calling the provider first and writing a receipt afterward;
- treating a connector tool success response as proof the resource now has the intended state;
- reusing an idempotency key for a modified request;
- accepting a stale provider version because another agent "probably did not change it";
- using one agent ID to represent multiple concurrent Claude sessions without session references;
- declaring a timeout failed just to unblock a dependency;
- hiding compensation steps in handoff prose;
- copying provider credentials into collaboration state;
- bypassing the broker because a provider app currently has an allow-all platform permission.

## Handoff Contract

A handoff must contain:

- source and destination agent IDs;
- workflow and intent references where applicable;
- resource key and connector ID;
- summary of what is already proven;
- artifact references;
- evidence references;
- current resource version reference when available;
- unresolved blocker or requested next action;
- whether an active claim remains and when it expires.

The receiving agent acknowledges before assuming responsibility. Completion stores a result reference rather than erasing the original handoff.

## Completion Criteria

Do not call collaborative connector work complete until:

- the correct agent/session is registered and current;
- all mutating work has a durable intent and exclusive claim;
- provider invocations are recorded with stable request identity;
- successful mutations have read-after-write verification evidence;
- final receipts preserve the true outcome, including uncertainty;
- downstream dependency states are refreshed;
- required handoffs are addressed and acknowledged;
- collaboration-state validation passes;
- no secret-like value entered the collaboration ledger.
