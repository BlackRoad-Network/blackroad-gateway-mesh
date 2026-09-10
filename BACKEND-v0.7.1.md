# BlackRoad connector, skill, and collaboration backend v0.7.1

Status: verified locally; exact package persisted privately; public deployment remains governance-blocked.

## v0.7.1 hardening

This release closes two concurrency gaps that matter when Claude sessions and connected tools operate at the same time.

### Restrictive unknown-connector policy

An unregistered connector no longer inherits broad mutation authority. The fallback policy is:

- reads remain discoverable by registered agents;
- mutation operators are limited to `connector-orchestrator` and `agent-instance-4`;
- every mutating class (`WRITE`, `COMMUNICATE`, `DEPLOY`, `ADMIN`, `SECRET`, `PUBLIC_EXPOSE`) requires governance evidence;
- every mutating class also requires explicit user-approval evidence;
- `agent-instance-4` participates as integrations steward.

Missing policy is therefore not interpreted as permission.

### Exact runtime-session binding

A logical agent identity such as `agent-instance-4` may have multiple concurrent Claude sessions. v0.7.1 binds a mutation to one exact live `sessionRef` across:

`intent -> participant approval -> exclusive claim -> executing -> invocation -> verification -> receipt`

A second Claude session using the same logical agent identity cannot inherit the first session's mutation authority. Stale or closed sessions are rejected before provider execution. Invocation retries must preserve both request hash and session identity.

## Verified inventory

- Gateway services: 62
- Plugin catalog entries: 83
- Installed skill resources observed: 312
- Canonical skill routes: 35
- Repository-native BlackRoad skill packages: 3
- Semantic evaluation families: 26
- Claude agent profiles: 6
- Collaboration actors: 7
- Explicit connector collaboration rules: 10 plus one restrictive default rule
- Provider adapter manifests: 62
- Distinct capabilities: 131
- Automated tests: 80 passed, 0 failed
- Receipt-tracked files: 83

## Exact private artifact

Private Drive title: `blackroad-plugin-gateway-v0.7.1.tar.gz`

Checksum companion: `blackroad-plugin-gateway-v0.7.1.sha256`

Archive SHA-256:

`cca34be81940f35dd2d7befa4368ac877465593cc151687c9fd704f063046f26`

The archive was extracted into a clean temporary directory and `npm run verify` passed there with all 80 tests green. The public repository intentionally omits private Drive object identifiers.

## Governance state

Public Netlify deployment remains blocked by the existing Neura Relay STOP decision until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` exist through the legitimate Registry administration path and a new decision permits deployment.

No live Tailscale policy, Service advertisement, Funnel exposure, provider secret, or ChatGPT app permission was changed by this release.
