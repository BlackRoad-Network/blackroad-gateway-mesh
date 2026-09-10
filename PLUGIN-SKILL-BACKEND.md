# BlackRoad plugin and skill backend

This layer turns installed connector and skill surfaces into a governed routing plane. It does **not** copy full skill bodies into the public gateway and does not silently alter ChatGPT permission settings.

## Canonical identities

- Plugin registry: `road://registry/plugins`
- Skill registry: `road://registry/skills`
- Permission policy: `road://policy/plugins`
- Gateway: `road://service/gateway`

## Selection model

1. Prefer a connected native connector when it directly performs the requested job.
2. Select one primary skill by provider and intent.
3. Load at most two supporting skills when the primary route explicitly names them.
4. Keep full skill bodies behind progressive disclosure.
5. Fall back to Plugin Management only when no specific route matches.
6. Never infer that an installed skill grants provider authority.

The session inventory observed 312 resources under `skills://plugins`. The repository stores only canonical route metadata and stable URIs. The actual installed catalog must be re-observed when freshness matters.

## Permission model

Repository recommendations are deliberately separate from ChatGPT's actual app-permission settings. The default recommendation is `ask_before_writes`. Sensitive classes use stricter tiers:

- secrets: `always_ask`
- network and identity administration: `always_ask`
- production deployment and public exposure: `always_ask`
- external communications and repository writes: `review_important_actions`

The September 2, 2026 read-only permission audit found high drift for Netlify and GitHub, which currently have app-specific `full_access`, and medium drift for Neura Relay MCP. No platform permission was changed during the audit. See `PERMISSION-DRIFT.md` and `plugins/observed-permissions.json`.

No permission change is considered applied unless the platform permission tool returns success for an explicit user-selected mode.

## Gateway metadata routes

- `/gateway/plugins`
- `/gateway/skills`
- `/gateway/skills/:id`
- `/gateway/skills/select?intent=...&provider=...`
- `/gateway/permissions`
- `/gateway/dependencies`

These routes return metadata only. They do not invoke a connector, load secrets, alter plugin settings, or execute a selected skill.

## Validation

```bash
npm run config
npm run check
npm test
```

`check-plugin-skills.mjs` verifies route identity, skill URI shape, permission tiers, high-risk mode restrictions, generated-file freshness, and dependency references.

## Six-agent profiles

`skills/agent-profiles.json` binds each `agent-instance-1` through `agent-instance-6` to owned domains, allowed skill routes, one concurrent mutation, required gates, handoff targets, and forbidden actions. Agent-scoped skill selection never falls back outside the allowlist.

## Adapter plane

Every registered service receives a generated adapter manifest under `/gateway/adapters`. The manifest joins connector state, skill routes, permission tier, provider-native authentication, write gate, secret model, and owner without enabling provider execution through the public gateway.

Public-safe orientation files:

- `BACKEND-SUMMARY.json`
- `skills/skill-router.summary.json`
- `plugins/adapter-provider-summary.json`
- `plugins/observed-permissions.json`

The exact v0.5.0 package is retained privately with its checksum recorded in `BACKEND-v0.5.0.md`.
