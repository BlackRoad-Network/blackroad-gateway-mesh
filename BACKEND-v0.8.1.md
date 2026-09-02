# BlackRoad connector, skill, and collaboration backend v0.8.1

Status: verified locally; durable external-drift reconciliation added; public deployment remains governance-blocked.

## Verified inventory

- Gateway services: 62
- Plugin catalog entries: 83
- Installed skill resources observed: 312
- Canonical skill routes: 35
- Repository-native BlackRoad skill packages: 3
- Semantic evaluation families: 30
- Claude agent profiles: 6
- Collaboration actors: 7
- Explicit connector collaboration rules: 10 plus restrictive fallback
- Provider adapter manifests: 62
- Distinct capabilities: 131
- Automated tests: 89 passed, 0 failed before final package rebuild

## v0.8.1: durable external drift ledger

Provider and repository changes that happen outside the collaboration broker are now first-class state rather than incidental surprises.

A changed stable resource version creates a durable drift record containing:

- exact resource and connector identity;
- previous and observed version references;
- observing agent and runtime session;
- optional source-actor reference;
- immutable evidence references;
- affected claims and intents;
- generated conflict references;
- explicit reconciliation lifecycle.

The first observation establishes a baseline and does not invent drift. A later different version creates drift even when no exclusive claim exists. If an exclusive claim is active, the drift links the generated `external-resource-version-change` conflict and stale mutation execution remains blocked before the provider call.

Drift resolution is explicit and does not erase history. The connector orchestrator, connector steward, or affected integration/target owner may reconcile from a live session with one of:

- `ACCEPT_REMOTE`
- `REPLAN`
- `SUPERSEDED`
- `NO_ACTION`

A result reference is mandatory. Related conflicts remain independent evidence until their own lifecycle is resolved.

## CLI additions

```text
road-collab resource-observe ... --source-actor-ref REF
road-collab drifts [--agent ID]
road-collab drift-resolve --agent ID --session-ref REF --drift DRIFT_ID --resolution REPLAN --result-ref REF
```

## Existing collaboration guarantees retained

- exact runtime-session binding for mutation lifecycle;
- restrictive unknown-connector defaults;
- exclusive resource claims and one active exclusive mutation per logical agent;
- request-hash-bound provider invocations;
- provider-native read-after-write verification;
- pre-provider BLOCKED/CANCELLED receipts without fake invocations;
- first-class external resource versions;
- workflow lifecycle derived from child intents;
- hash-chained events, handoffs, receipts, and conflict evidence;
- `TIMEOUT_UNKNOWN` remains ambiguous until evidence resolves it.

## Governance state

Public Netlify deployment remains blocked by Neura Relay until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` are registered through the legitimate Registry administration path and a new decision permits deployment.

No live Tailscale policy, Service advertisement, Funnel exposure, provider secret, or ChatGPT app permission is changed by v0.8.1.
