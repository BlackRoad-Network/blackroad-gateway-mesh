# BlackRoad connector, skill, and agent-collaboration backend v0.7.0

Status: verified locally; public deployment remains governance-blocked.

## First-class collaboration

Canonical identity: `road://service/collaboration`

Private service identity: `svc:collaboration`

Every connector-active agent session is represented independently from the logical agent identity. Provider mutations use this durable chain:

`workflow? -> intent -> gate evidence -> exclusive claim -> invocation.start -> provider-native call -> invocation.finish -> read-after-write verification -> receipt -> handoff`

Connector invocations are first-class durable records with request hashes, provider request references, response hashes, resource keys, effect references, session identity, workflow causality, idempotency, and verification state.

Successful provider writes cannot close as successful without read-after-write evidence. Stale expected resource versions are rejected before mutation. Timeouts remain `TIMEOUT_UNKNOWN` rather than becoming fabricated failures or successes.

## Verified inventory

- Gateway services: 62
- Plugin catalog entries: 83
- Installed skill resources observed: 312
- Canonical skill routes: 35
- Repository-native BlackRoad skill packages: 3
- Semantic evaluation families: 24
- Agent profiles: 6
- Collaboration actors: 7
- Collaboration connector rules: 10
- Provider adapter manifests: 62
- Distinct capabilities: 131
- Automated tests: 67 passed, 0 failed
- Receipt-tracked files: 82

## Agent collaboration guarantees

- Six Claude workspace agents plus one connector orchestrator.
- Distinct session identities per concurrent Claude session.
- One active exclusive mutation per logical agent.
- One active exclusive claim per resource.
- Shared reads may overlap; conflicting writes may not.
- Mutations require idempotency keys and target ownership.
- Provider execution remains provider-native.
- Provider success is not accepted as state convergence until verified by read-back.
- Workflows record causal dependencies and compensation intent.
- Handoffs are addressed and receipted.
- Collaboration state rejects secret-like fields and secret values.
- HMAC-signed hosted requests bind method, path, body hash, agent, timestamp, and nonce.
- Replay is rejected.
- State updates use compare-and-swap persistence and hash-chained events.
- Old collaboration v1 state upgrades to v2 without discarding evidence.

## Workspace bootstrap

After installation under `/Users/alexa/workspace`, all agents share:

`/Users/alexa/workspace/.road-agents/shared/COLLABORATION.md`

and can use:

`/Users/alexa/workspace/bin/road-collab`

The bootstrap contract requires heartbeat/session registration at the start of connector-active work and session close at turn completion.

## Exact private artifact

Private Drive title: `blackroad-plugin-gateway-v0.7.0.tar.gz`

Archive SHA-256: `518cefc2ffab629f78a3229e9b54f7945f515cfd88ee6da1e8b416230369d763`

The archive was extracted into a clean temporary directory and `npm run verify` passed there. The public repository intentionally omits the private Drive object identifier.

## Governance state

Public Netlify deployment remains blocked by the existing Neura Relay STOP decision until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` exist through the legitimate Registry administration path and a new decision permits deployment.

No live Tailscale policy, Service advertisement, Funnel exposure, provider secret, or ChatGPT app permission is changed by v0.7.0 verification or packaging.
