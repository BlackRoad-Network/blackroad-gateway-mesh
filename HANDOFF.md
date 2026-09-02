# BlackRoad Gateway handoff

## Current state

- Netlify project exists: `blackroad-plugin-gateway`.
- Gateway source is prepared locally and exposes read-only discovery routes.
- Public deployment is intentionally blocked by a Neura Relay decision until the gateway participant/capability exists in the Neura Registry.
- Tailscale is the intended private service plane. No tailnet configuration has been changed from this environment.

## Gateway routes

- `/gateway`
- `/gateway/services`
- `/gateway/services/:id`
- `/gateway/health`
- `/gateway/capabilities`

## Safety model

- No provider secret values are returned.
- Connector authentication does not imply write authority.
- Funnel remains opt-in only.
- Timeouts remain unknown, not offline.
- Provider-native control planes remain behind their native auth boundaries.

## Immediate unblock sequence

1. Register `blackroad-gateway` and capability `gateway.registry.deploy@1` in Neura Registry using `neura/gateway-passport-request.json`.
2. Re-run the Neura Action Card for public gateway deployment.
3. On a real tailnet node, run `scripts/tailscale-preflight.sh`.
4. Confirm actual local listeners before applying any Tailscale Service config.
5. Merge least-privilege grants into the existing tailnet policy; never replace the whole policy blindly.
6. Deploy the gateway only after the Neura decision permits it.
