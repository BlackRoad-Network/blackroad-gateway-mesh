# BlackRoad connector, skill, and collaboration backend v0.7.2

Status: verified in a clean extract; exact package persisted privately; public deployment remains governance-blocked.

## Verified inventory

- Gateway services: 62
- Plugin catalog entries: 83
- Installed skill resources observed: 312
- Canonical skill routes: 35
- Repository-native BlackRoad skill packages: 3
- Semantic skill evaluation families: 26
- Claude agent profiles: 6
- Collaboration actors: 7
- Explicit connector collaboration rules: 10
- Policy-mapped gateway connectors: 62
- Collaboration policy profiles: 15
- Provider adapter manifests: 62
- Distinct capabilities: 131
- Automated tests: 82 passed, 0 failed
- Receipt-tracked files: 86

## Runtime policy resolution

The executable collaboration broker resolves connector policy in this order:

1. explicit provider-specific connector rule;
2. reviewed connector policy profile from the gateway adapter map;
3. restrictive unknown-connector fallback.

This preserves specialized rules where they exist while ensuring all 62 gateway adapters inherit deliberate collaboration behavior instead of accidental default authority.

## Policy families

The reviewed collaboration policy families cover:

- internal services
- source control
- hosting/deployment
- compute/network
- data systems
- financial systems
- communications
- productivity/documents
- identity/secrets
- AI/model systems
- observability
- domain/routing
- local bridges
- decision gates
- restrictive unknown connectors

Stripe is intentionally mapped to the strict `financial` profile rather than generic `data-system`. All financial mutation classes require governance evidence, explicit user approval, and integrations-steward participation.

## Cross-connector workflow templates

Six causal workflow templates are published:

1. `code-to-public-deploy`
2. `device-to-private-service`
3. `connector-onboarding`
4. `email-event-to-task`
5. `model-serving`
6. `docs-to-signature`

Templates describe integration owner, participants, dependency edges, verification requirements, and explicit compensation intent where rollback behavior is meaningful. They do not use wall-clock delays as causal proof.

## First-class collaboration invariants

- logical agent identity is separate from runtime session identity;
- mutation authority remains bound to one exact live `sessionRef`;
- reads may overlap but conflicting writes may not;
- one active exclusive mutation per logical agent;
- one active exclusive claim per resource;
- known resource-version mismatches block stale writes;
- provider invocations are durable first-class records;
- invocation retries preserve stable non-secret request identity;
- provider write success is not completion until read-after-write verification succeeds;
- `TIMEOUT_UNKNOWN` is preserved until fresh provider evidence resolves it;
- cross-connector dependencies and compensation are explicit;
- secrets never enter collaboration metadata;
- missing connector policy resolves to the restrictive fallback, not permission.

## Exact private artifact

Private Drive titles:

- `blackroad-plugin-gateway-v0.7.2.tar.gz`
- `blackroad-plugin-gateway-v0.7.2.sha256`

Archive SHA-256:

`9e6b34bcdac549a238752bd62563b055f100be608d996f7511709224e62205ce`

The archive was extracted into a clean temporary directory and `npm run verify` passed there with all 82 tests green.

The public repository intentionally omits private Drive object identifiers.

## Governance state

Public Netlify deployment remains blocked by the existing Neura Relay STOP decision until participant `blackroad-gateway` and capability version `gateway.registry.deploy@1` exist through the legitimate Registry administration path and a new decision permits deployment.

No live Tailscale policy, Tailscale Service advertisement, Funnel exposure, provider secret, financial action, or ChatGPT app permission was changed by v0.7.2 verification or packaging.
