# Gateway repair queue

## Governance blocker

1. Register Neura participant `blackroad-gateway`.
2. Register capability version `gateway.registry.deploy@1`.
3. Re-run the deployment Action Card.

## Private mesh

1. Run `scripts/tailscale-preflight.sh` on an actual BlackRoad tailnet node.
2. Verify real listeners before advertising Services.
3. Create/resolve `group:blackroad-operators` or the canonical replacement.
4. Merge grants into the existing policy.
5. Keep Funnel disabled unless separately authorized.

## Provider repair

- QuickNode: `AUTH_FAILED`.
- Stripe: `AUTH_REQUIRED`.
- Amplitude: `ACCOUNT_CONNECTION_FAILED`.
- Fireflies: `FORBIDDEN_403`.
- MeetGeek: `MISCONFIGURED_CLIENT_HEADER`.
- WorkOS: account authenticated but not provisioned.
- Granola: connector present, no account.
- GSC Wizard: callable, no properties connected.
- Resend: connected, no domains/webhooks/events.
- Semrush: connected, additional API units required.
- Railway API/orchestrator/cloud/Roadie/core: configured domains, no active deployment.
- Supabase: inactive.
- Windsor.ai: `TIMEOUT_UNKNOWN`; do not classify as disconnected.

## Verification rule

Never turn a timeout, zero result, auth rejection, or missing configuration into `DOES_NOT_EXIST`.
