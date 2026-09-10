# BlackRoad provider adapter contract

Each connector is represented as a provider adapter behind a canonical BlackRoad identity.

```text
road://connector/<id>
        ↓
connector metadata + capability contract
        ↓
authority decision
        ↓
provider-native connector / MCP / API / local bridge
        ↓
provider resource
```

## Common operations

Every adapter may implement some subset of:

- `discover` — enumerate non-secret provider capabilities/resources.
- `health` — return observed reachability/auth/config state.
- `capabilities` — describe supported operations without granting them.
- `read` — retrieve authorized data.
- `write` — create/update non-administrative provider state.
- `admin` — security, billing, account, permission, deployment, or destructive changes.
- `secret-reference` — resolve a secret reference through an approved secret manager without returning the secret in registry output.

Unsupported operations MUST be absent, not simulated.

## Authority tiers

### READ

Metadata discovery, health, safe listing, and provider reads explicitly allowed by the provider connection.

### WRITE

Changes to provider state. Requires an actor capability and provider-native authorization. Authentication alone is insufficient.

### ADMIN

Permission changes, deployments, DNS changes, billing, destructive operations, account settings, public exposure, and equivalent high-impact actions. Requires an explicit high-impact capability decision.

### SECRET

Secret values remain in the provider/secret manager. Gateway metadata may reference a secret name or location, never return the value.

## Adapter state

Adapters report observed state using the normalized gateway vocabulary while retaining the raw provider state separately.

Examples:

- `READY`
- `READY_EMPTY`
- `LOCAL_BRIDGE`
- `AUTH_REQUIRED`
- `AUTH_FAILED`
- `FORBIDDEN`
- `MISCONFIGURED`
- `CONFIG_REQUIRED`
- `LIMIT_REQUIRED`
- `INACTIVE`
- `UNVERIFIED`
- `TIMEOUT_UNKNOWN`
- `UNKNOWN`

A later successful observation may supersede an earlier state, but historical receipts should remain available.

## Secret manager boundary

Prefer 1Password Developer Environments or another explicitly approved secret store for secret references. Do not copy provider credentials into the public gateway registry.

## Governance boundary

Neura Relay may gate proposed actions, but Relay does not execute the downstream provider action. BlackRoad must retain the distinction between:

1. proposal,
2. authority decision,
3. provider execution,
4. verification,
5. receipt.

## Public exposure

No adapter becomes public because it is connected. Public exposure is a separate capability and route decision. Tailscale Funnel, public reverse proxies, DNS publication, and public Netlify endpoints must therefore be explicitly authorized.
