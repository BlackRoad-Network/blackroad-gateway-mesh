# BlackRoad agent collaboration bootstrap

Every BlackRoad agent working in `/Users/alexa/workspace` must treat the shared collaboration broker as the coordination authority for connector and shared-resource mutations.

Canonical local CLI:

```bash
/Users/alexa/workspace/bin/road-collab
```

Canonical state:

```text
/Users/alexa/workspace/.road-agents/shared/collaboration/state.json
/Users/alexa/workspace/.road-agents/shared/collaboration/events.jsonl
```

## Start of a connector-active turn

Register presence with a session reference unique to the current runtime session:

```bash
road-collab heartbeat \
  --agent agent-instance-N \
  --runtime claude-workspace \
  --provider anthropic \
  --session-ref SESSION_REF
```

Then inspect:

```bash
road-collab status
road-collab view --agent agent-instance-N
```

## Before a provider or repository write

1. Create a workflow if the task spans connectors or agents. Name one integration owner and attach a delegation-contract reference when work is delegated.
2. Create a mutating intent with connector, action class, exact resource key, target owner, idempotency key, expected resource version when known, and the current `sessionRef`.
3. Satisfy participant, governance, and user-approval gates. Mutating participant approvals must come from live participant sessions.
4. Acquire the exclusive claim using the same live `sessionRef` that created the intent.
5. Mark the intent executing from that exact session.
6. Start a durable invocation from that same session with tool name and a stable non-secret request hash.
7. Only then call the provider-native tool.
8. Finish the invocation from the same runtime session, or from a separately authenticated live connector-orchestrator recovery session.
9. Read the affected resource back.
10. Record verification with evidence and a stable observed version reference when available.
11. Record the final receipt from the bound session or explicit broker recovery session.
12. Hand off verified state when another agent owns the next step.

A platform connector returning success is not the final BlackRoad completion condition for a mutation. Read-after-write verification is required.

## Unknown connectors

Unregistered connectors default to a conservative policy. Reads remain available for discovery, but mutations are restricted to the connector orchestrator and `agent-instance-4`, require integrations-steward participation, and require governance plus explicit user-approval evidence for every mutating action class. Missing policy is not broad permission.

## Before a read

Reads may use shared claims and may overlap. Record observations that downstream agents depend on, especially health, provider status, endpoint identity, and resource versions.

## Hard rules

- Do not write a resource held by another active exclusive claim.
- Do not execute from a stale expected resource version.
- Do not use another Claude session's request identity, claim, lease, invocation, verification, or receipt authority.
- Do not close a runtime session while it owns active mutation work; release or finish the work first.
- Do not start a mutating invocation without a stable non-secret request hash.
- Do not put secrets in collaboration state.
- Do not collapse `TIMEOUT_UNKNOWN` into failure or success.
- Do not bypass provider-native authentication, user approval, or Neura governance.
- Do not make a connector write merely because the ChatGPT app permission says `Allow all actions`.

## End of turn

Close or complete outstanding handoffs, record receipts for executed provider calls, release unused claims, and close the runtime session when work is complete:

```bash
road-collab session-close --agent agent-instance-N --session-ref SESSION_REF
```
