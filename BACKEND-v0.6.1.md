# BlackRoad plugin, skill, and collaboration backend v0.6.1

Status: verified, packaged, private artifacts persisted, public deployment blocked.

## Verified inventory

- Gateway services: 61
- Plugin catalog entries: 82
- Installed skill resources observed: 312
- Canonical skill routes: 34
- BlackRoad repository-native skill packages: 2
- Semantic evaluation families: 16
- Agent profiles: 6
- Collaboration actors: 7, comprising one connector orchestrator plus six Claude workspace agents
- Provider adapter manifests: 61
- Distinct capabilities: 121
- Platform app observations: 21
- Permission-policy overrides: 25
- Automated tests: 57 passed, 0 failed
- Receipt-tracked files: 67

## Exact artifacts

Private Drive titles:

- `blackroad-plugin-gateway-v0.6.1.tar.gz`
- `blackroad-plugin-gateway-v0.6.1.sha256`

Archive SHA-256:

`324ef95594301228a3bdc0609b679c37171e950b2c04141880c0d0be7114af2e`

The archive was extracted into a clean temporary directory and `npm run verify` passed there. The public repository intentionally omits private Drive object identifiers.

## v0.6.1 correction

The platform observation now records GitHub source writes as `WRITE_VERIFIED`, because commits to `gateway-registry-v1` succeeded during this refresh. The older `SURFACE_UNAVAILABLE` observation was corrected at its source, regenerated, and tested instead of being preserved as stale folklore.

## Plugin and skill plane

- Timestamped hosted-app permission observations remain separate from recommended BlackRoad policy.
- Repository-native skills remain distinct from provider-native Agent skills and installed plugin skills.
- One primary skill and no more than two supporting skills are selected through progressive disclosure.
- A successful empty provider result remains `READY_EMPTY` rather than being rewritten as missing or disconnected.

## Collaboration plane

Canonical identity: `road://service/collaboration`

Private service identity: `svc:collaboration`

The broker coordinates claims, intents, handoffs, receipts, conflicts, connector observations, dependency state, and agent heartbeats. Mutations use target ownership, idempotency keys, exclusive resource claims, bounded concurrency, HMAC-signed requests, nonce replay rejection, compare-and-swap persistence, and a hash-chained event ledger.

## Governance state

Public deployment remains blocked by the existing Neura Relay STOP decision until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` exist in the Neura Registry and a new decision permits deployment.

No live Tailscale policy, Service advertisement, Funnel exposure, provider secret, or ChatGPT app permission was changed by this packaging step.
