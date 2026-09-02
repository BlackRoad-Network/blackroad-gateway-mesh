# Connector collaboration middleware contract

Every connector adapter that can produce externally observable side effects should implement the same BlackRoad collaboration lifecycle around its provider-native call.

This contract coordinates calls. It does not proxy provider credentials and does not replace provider-native authentication.

## Preflight

For `OBSERVE` and `READ`, register or refresh the agent session and inspect relevant claims/resources. Shared reads may overlap.

For `WRITE`, `COMMUNICATE`, `DEPLOY`, `ADMIN`, `SECRET`, and `PUBLIC_EXPOSE`:

1. Require a live `sessionRef` for the executing logical agent.
2. Resolve the connector-specific collaboration rule. If none exists, use the restrictive default rule.
3. Create or reuse the semantic workflow when the operation has cross-connector dependencies.
4. Create the mutating intent with exact `resourceKey`, `targetOwnerAgent`, `idempotencyKey`, and `expectedResourceVersionRef` when known.
5. Satisfy participant, governance, and user-approval gates.
6. Acquire the exact exclusive claim for the resource from the bound session.
7. Mark the intent executing.
8. Canonicalize the non-secret provider request and compute a stable request hash.
9. Start the connector invocation with that hash and current session.

If any step fails, **do not call the provider**.

## Provider execution

Execute through the native connector/tool with its own authentication boundary. Do not forward collaboration HMAC material or copy provider secrets into the collaboration plane.

Capture only safe opaque evidence such as:

- provider request/trace IDs;
- resource IDs;
- deployment IDs;
- repository commit SHAs;
- revision IDs;
- ETags or generation references;
- provider URLs that do not contain secrets.

## Postflight

Record `invocation.finish` with the provider outcome.

For reads, record an observation if another agent or later workflow step depends on the result.

For mutations:

1. A provider success transitions to `VERIFYING`, not directly to BlackRoad success.
2. Read the affected resource back using the provider-native read surface.
3. Compare the observed state against the intended outcome.
4. Record `verification.record` with evidence references and the observed resource version when available.
5. Only a verified mutation may receive a `SUCCEEDED` receipt.
6. Release/complete the exclusive claim through the bound session.
7. Re-evaluate dependent workflow intents.
8. Publish an addressed handoff when another agent owns the next step.

## Timeout handling

If the provider call times out or its result is ambiguous:

- record `TIMEOUT_UNKNOWN`;
- do not immediately retry with changed parameters;
- perform read-back to determine whether the effect occurred;
- preserve the original idempotency identity when a true retry is appropriate;
- keep downstream dependent actions blocked until evidence resolves the ambiguity.

## Cross-session rule

The same logical `agent-instance-N` may have multiple Claude sessions. Mutation authority does not flow between them automatically. The session that created the mutating intent owns the claim, execution, invocation, verification, and receipt lifecycle unless an explicit broker recovery path is used.

## Unknown connector rule

A connector without a reviewed provider-specific rule is not "open." Reads are discoverable, but all mutation classes use the restrictive fallback: connector orchestrator or integrations steward only, with `agent-instance-4` participation plus governance and explicit user approval.

## Connector adapter output

Adapters should be able to expose a safe operation envelope conforming to `collaboration/connector-operation.schema.json`. It is acceptable for fields to remain null before their corresponding lifecycle phase, but successful mutations must end with invocation, verification evidence, observed version where available, and receipt identity.
