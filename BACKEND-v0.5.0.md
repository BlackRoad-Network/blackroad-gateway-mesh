# BlackRoad plugin and skill backend v0.5.0

Status: verified, packaged, private artifact persisted, public deployment blocked.

## Verified inventory

- Gateway services: 61
- Plugin catalog entries: 82
- Installed skill resources observed: 312
- Canonical skill routes: 32
- Agent profiles: 6
- Generated adapter manifests: 61
- Distinct capabilities: 116
- Permission overrides: 17
- Automated tests: 25 passed, 0 failed
- Receipt-tracked files: 45

## Artifact

The exact source package is stored in the connected private Google Drive root as:

`blackroad-plugin-gateway-v0.5.0.tar.gz`

SHA-256:

`fb251c57a4461168991ffcd459efa952e9e7bd266ea7a4caa303a0d0661d4723`

Size: 71,722 bytes.

The public repository deliberately does not expose the private Drive object identifier. Resolve the artifact by exact title through the connected Drive surface.

## Backend routes

- `/gateway/plugins`
- `/gateway/adapters`
- `/gateway/adapters/:id`
- `/gateway/agents`
- `/gateway/agents/:id`
- `/gateway/skills`
- `/gateway/skills/:id`
- `/gateway/skills/select?intent=...&provider=...&agent=agent-instance-N`
- `/gateway/permissions`
- `/gateway/dependencies`

## Safety state

- Repository permission recommendations do not claim to modify ChatGPT plugin permissions.
- Installed skills do not imply actor authority.
- Provider authentication does not imply write authority.
- Connector secrets remain reference-only.
- Public deployment remains blocked by the current Neura Relay STOP decision.
- Tailscale service advertisement remains listener-gated and Funnel remains opt-in.

## Restore and verify

After retrieving the archive into `/Users/alexa/workspace`:

```bash
tar -xzf blackroad-plugin-gateway-v0.5.0.tar.gz
cd blackroad-plugin-gateway
npm run verify
```
