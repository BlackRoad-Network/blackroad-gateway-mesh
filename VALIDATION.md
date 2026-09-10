# Validation record

## Local source validation

- `registry.schema.json`: JSON parse OK.
- `connector-contract.schema.json`: JSON parse OK.
- `tailscale-services.plan.json`: JSON parse OK.
- `neura/gateway-passport-request.json`: JSON parse OK.
- `netlify/edge-functions/gateway.ts`: `tsc --noEmit` passed with a minimal Netlify-compatible type stub.
- `bin/road-gateway`: `bash -n` passed and `--help` executes.
- `scripts/gateway-doctor.sh`: `bash -n` passed.
- `scripts/tailscale-activate-identity.sh`: `bash -n` passed locally before commit.
- Status normalization cases passed locally for:
  - READY
  - CONNECTED
  - READY_EMPTY
  - TIMEOUT_UNKNOWN
  - AUTH_FAILED
  - AUTH_REQUIRED
  - MISCONFIGURED
  - FORBIDDEN
  - INACTIVE
  - CONFIG_REQUIRED
  - LIMIT_REQUIRED
  - UNVERIFIED
  - LOCAL_BRIDGE
- HTTP handler runtime tests passed for gateway manifest, service list, health, capabilities, known-service lookup, timeout preservation, and unknown-service 404 behavior.

## External state verified

- Netlify project exists: `blackroad-plugin-gateway` (`ffcf1f12-619e-4999-a3bd-3e7dc89ac308`).
- Netlify connector-state environment registry exists.
- `BlackRoad-Network/blackroad-gateway-mesh` is non-archived and writable through the connected GitHub installation.
- Tailscale configuration has **not** been modified from this environment.
- Public Netlify deployment has **not** been triggered after Neura returned STOP.
- DigitalOcean `codex-infinity` and `shellfish-droplet` are active compute nodes; neither is claimed as a gateway host until transport/listener verification succeeds.
- BlackRoad OS PostHog currently has no managed reverse proxy configured.

## Governance receipts

- Public deploy: `decision_receipt_cba826c5eea31dfe` -> STOP.
- Self-status metadata update: `decision_receipt_c940056cb62777e3` -> STOP.

Both decisions report the same root blocker: the Neura Registry does not contain the `blackroad-gateway` participant/capability version yet.
