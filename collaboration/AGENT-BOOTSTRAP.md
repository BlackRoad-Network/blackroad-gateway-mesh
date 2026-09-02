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

1. Create a workflow if the task spans connectors or agents.
2. Create a mutating intent with connector, action class, exact resource key, target owner, idempotency key, and expected resource version when known.
3. Satisfy participant, governance, and user-approval gates.
4. Acquire the exclusive claim.
5. Mark the intent executing.
6. Start a durable invocation with tool name and safe request hash.
7. Only then call the provider-native tool.
8. Finish the invocation with the real provider outcome.
9. Read the affected resource back.
10. Record verification with evidence and a stable observed version reference when available.
11. Record the final receipt.
12. Hand off verified state when another agent owns the next step.

A platform connector returning success is not the final BlackRoad completion condition for a mutation. Read-after-write verification is required.

## Before a read

Reads may use shared claims and may overlap. Record observations that downstream agents depend on, especially health, provider status, endpoint identity, and resource versions.

## Hard rules

- Do not write a resource held by another active exclusive claim.
- Do not execute from a stale expected resource version.
- Do not use another Claude session's request identity.
- Do not put secrets in collaboration state.
- Do not collapse `TIMEOUT_UNKNOWN` into failure or success.
- Do not bypass provider-native authentication, user approval, or Neura governance.
- Do not make a connector write merely because the ChatGPT app permission says `Allow all actions`.

## End of turn

Close or complete outstanding handoffs, record receipts for executed provider calls, release unused claims, and close the runtime session when work is complete:

```bash
road-collab session-close --agent agent-instance-N --session-ref SESSION_REF
```
