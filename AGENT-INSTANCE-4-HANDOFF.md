# Agent-instance-4 handoff: integrations gateway

Owner: agent-instance-4

Workspace target:

`/Users/alexa/workspace`

Canonical working branch:

`BlackRoad-Network/blackroad-gateway-mesh:gateway-registry-v1`

Draft PR: #1

## Do first

1. Locate or clone the repo under the existing canonical workspace structure. Do not create another gateway repository.
2. Check out `gateway-registry-v1`.
3. Read, in order:
   - `HANDOFF.md`
   - `VALIDATION.md`
   - `REPAIR-QUEUE.md`
   - `ADAPTERS.md`
   - `tailscale-services.plan.json`
4. Run shell syntax checks on `bin/road-gateway` and scripts.
5. Run `scripts/tailscale-preflight.sh` only on an authorized BlackRoad tailnet node.

## Do not do yet

- Do not deploy the public Netlify gateway.
- Do not mutate Netlify gateway environment state.
- Do not apply Tailscale service configuration until a real local listener is confirmed.
- Do not enable Funnel.
- Do not copy provider secrets into repo files or gateway metadata.

Neura Relay has returned STOP for both the public deploy and a gateway self-status metadata mutation because the `blackroad-gateway` participant/capability version is missing from the Neura Registry.

## Highest priority work that remains safe

1. Reconcile the 56 connector definitions against any canonical integration registry already present under `/Users/alexa/workspace`.
2. Map each connector to the authority contract: READ / WRITE / ADMIN / SECRET.
3. Verify local Tailscale state and actual listeners.
4. Verify SSH/Tailscale reachability of `codex-infinity` and `shellfish-droplet` before considering them service hosts.
5. Find the administrative path that owns Neura Registry participant/capability registration and submit the prepared request through that legitimate path.
6. Once the passport exists, re-run the Neura deployment Action Card. Deploy only if the new decision permits it.

## Service identity targets

- `road://gateway` -> `svc:blackroad-gateway`
- `road://service/forge` -> `svc:forge`
- `road://service/roadie` -> `svc:roadie`
- `road://service/identity` -> `svc:identity`
- `road://service/devices` -> `svc:devices`
- `road://service/integrations` -> `svc:integrations`
- `road://service/models` -> `svc:models`
- `road://service/receipts` -> `svc:receipts`

Preserve identity/location separation. A service identity is not an IP address and a connector authentication is not authority to mutate the provider.
