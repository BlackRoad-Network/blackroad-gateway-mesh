# Collaboration protocol reference

The BlackRoad collaboration plane exists because multiple autonomous agents can reach the same external systems at the same time. Provider APIs, repository branches, DNS zones, deployment targets, communication channels, and identity systems are shared mutable state. Ordinary chat context is not a lock manager, and provider authentication is not a transaction protocol.

## Identity layers

The protocol distinguishes four layers that are easy to collapse accidentally:

1. **Logical agent**: `agent-instance-1` through `agent-instance-6`, plus the connector orchestrator. This represents durable responsibility and ownership.
2. **Runtime session**: a concrete Claude workspace session, ChatGPT connector session, or future Road runtime session. Sessions have independent heartbeats and may become stale without changing the logical agent definition.
3. **Connector identity**: GitHub, Netlify, Tailscale, Slack, Gmail, Resend, and other provider/native surfaces. Connector availability says nothing about an actor's authority to mutate a particular target.
4. **Resource identity**: the exact shared object being observed or mutated, expressed as a stable resource key. Claims and resource versions attach here.

A connector invocation therefore records agent, session, connector, intent, workflow, tool name, resource, request hash, provider request reference, outcome, and verification evidence. This allows a later agent to determine not merely that "Claude changed GitHub" but which logical agent, which session, which intended change, which exact provider operation, and which read-back proved the resulting state.

## Mutation sequence

A correct provider mutation follows this causal chain:

`heartbeat -> workflow(optional) -> intent -> participant/governance approval -> claim -> executing -> invocation.start -> provider call -> invocation.finish -> provider read-back -> verification.record -> receipt.record -> handoff(optional)`

Skipping directly from intent to receipt is forbidden for mutations in protocol v2. Provider success is an acknowledgment that a request completed according to the provider, not proof that the desired end state now exists. The verification phase must observe the affected resource again using a read surface independent enough to falsify the expected result.

## Resource versions

When the provider exposes a stable version, ETag, blob SHA, revision ID, deployment ID, configuration generation, or other useful concurrency token, record it as the resource version reference. Later mutating intents may carry `expectedResourceVersionRef`. If the current shared resource version differs, the mutation is rejected before a provider call. This prevents the classic lost-update failure where two agents both read version A and then each write a different version B.

Not every provider exposes a clean version token. In that case the resource version may be null and correctness relies on exclusive claims plus provider-specific conditional writes where available. Never fabricate a version string merely to satisfy the field.

## Invocation idempotency

Intent idempotency prevents semantic duplicate operations. Invocation request hashes additionally prevent a subtler error: retrying an existing logical operation with changed parameters. A retry may reuse the active invocation only when the safe request representation hashes identically. If the request shape changed, create a new semantic intent or resolve the existing one explicitly.

The hash should cover the non-secret semantic request. Never hash a raw secret and publish the resulting digest as if a one-way hash automatically makes low-entropy credentials safe.

## Timeouts and ambiguous effects

A provider timeout is especially dangerous for mutations because the external system may have applied the action even when the caller never received the response. The correct state is `TIMEOUT_UNKNOWN`. Keep the claim or transition it according to the operator's recovery policy, then perform provider read-back. If evidence shows the intended effect exists, record verification and resolve the intent accordingly. If evidence proves it did not occur, create or retry an appropriately idempotent operation. Do not translate timeout into failure merely to keep a workflow moving.

## Cross-connector workflows

A workflow groups related intents across connectors. Dependency edges determine when downstream operations become eligible. Example: a GitHub configuration commit may precede a Netlify metadata update, which may precede a Slack notification. The Slack intent should depend on verified success of the prior operation rather than on wall-clock timing or a human-readable note.

Compensation is modeled explicitly. For example, if a DNS cutover succeeds but deployment verification fails, a rollback DNS intent can be linked via `compensationForIntentId`. Compensation is not automatic proof of safety. It still needs its own authority, claim, provider invocation, and verification.

## Local and hosted broker modes

The same collaboration core supports a local filesystem broker in `/Users/alexa/workspace/.road-agents/shared/collaboration` and a future hosted broker backed by strongly consistent Netlify Blob conditional writes. The local CLI uses an atomic filesystem lock, fsync where available, atomic rename, and append-only event records. The hosted handler uses compare-and-swap with ETags and bounded retries.

The hosted collaboration endpoint is not a provider proxy. It stores coordination metadata and safe opaque references. Provider tools continue to authenticate directly with their native control planes.

## Handoffs and ownership

Ownership should move through addressed handoffs, not through informal observation that another agent "seems done." A handoff is immutable evidence of the transfer request. The recipient acknowledges it, then closes it with a result reference or rejection. The original handoff remains in state for auditability.

A target owner is required on mutating intents. The connector orchestrator may coordinate provider calls but cannot silently make itself owner of another agent's domain. This is especially important when Claude instances and ChatGPT connectors are both active because platform-level tool access can otherwise make ownership invisible.

## Evidence hygiene

Safe references include repository commits, provider object IDs that are not secrets, opaque request IDs, deployment IDs, file paths, and receipt IDs. Collaboration state must reject keys or values that resemble secrets. Never store API keys, passwords, cookies, authorization headers, OAuth refresh tokens, private SSH keys, signing keys, or secret-bearing URLs.

## Operational rule

Before any externally consequential connector write, an agent should be able to answer five questions from machine-readable collaboration state:

1. Who owns this target?
2. Does anyone else hold an active exclusive claim?
3. Which exact intent authorizes this action?
4. Which provider invocation corresponds to the tool call?
5. What read-back evidence will prove the effect?

If one of those answers is missing, the collaboration layer is not ready for the mutation.

## Unknown connectors and conservative defaults

An installed connector may appear before a BlackRoad-specific stewardship rule exists. Discovery must still work, otherwise registration becomes impossible. Therefore the fallback permits reads from any registered agent, but it does not grant universal mutation authority. Unknown-provider mutations are restricted to the connector orchestrator and integrations steward (`agent-instance-4`), and every mutating class is governance-gated, user-approval-gated, and requires integrations-steward participation. Once the connector receives an explicit reviewed rule, that provider-specific contract replaces the conservative fallback. Missing policy is never interpreted as broad permission.

## Session continuity

The logical agent name is not sufficient proof that the same runtime is still performing a mutation. A mutating intent records the exact live `sessionRef`. Approval records that represent agent participation require a live session for the approving agent. The mutation claim, transition to execution, provider invocation, provider result, read-after-write verification, and final receipt must preserve session continuity. Another Claude session using the same logical `agent-instance-N` cannot inherit this authority merely because it shares the role name. If the session becomes stale or closes before the provider operation starts, the mutation stops before provider execution and must be resumed through an explicit reconciliation path rather than silently reassigned.
