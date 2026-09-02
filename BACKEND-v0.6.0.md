# BlackRoad plugin, skill, and collaboration backend v0.6.0

Status: verified, packaged, private artifact persisted, public deployment blocked.

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
- Automated tests: 49 passed, 0 failed
- Receipt-tracked files: 67

## Exact artifact

Private Drive title:

`blackroad-plugin-gateway-v0.6.0.tar.gz`

SHA-256:

`cdf5722e5315bb2a35d171cf191cb760501a8807a76e46a6f9d5cc962a7783d1`

The archive was extracted into a clean temporary directory and `npm run verify` passed there. The public repository intentionally omits the private Drive object identifier.

## Added backend planes

### Plugin and skill plane

- Timestamped hosted-app permission observations remain separate from recommended BlackRoad policy.
- Repository-native skills remain distinct from provider-native Agent skills and installed plugin skills.
- One primary skill and no more than two supporting skills are selected through progressive disclosure.
- A successful empty provider result remains `READY_EMPTY` rather than being rewritten as missing or disconnected.

### Collaboration plane

Canonical identity:

`road://service/collaboration`

Tailscale service identity:

`svc:collaboration`

The broker coordinates claims, intents, handoffs, receipts, conflicts, and agent heartbeats. Mutations use idempotency keys, exclusive resource claims, bounded concurrency, HMAC-signed requests, nonce replay rejection, compare-and-swap persistence, and a hash-chained event ledger.

## Governance state

Public deployment remains blocked by the existing Neura Relay STOP decision until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` exist in the Neura Registry and a new decision permits deployment.

No live Tailscale policy, Service advertisement, Funnel exposure, provider secret, or ChatGPT app permission was changed by this packaging step.
