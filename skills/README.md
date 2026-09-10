# BlackRoad backend skills

The gateway uses progressive disclosure:

- `skill-router.json` indexes installed and repository-native skill entrypoints.
- `repository-packages.json` records BlackRoad-owned skill packages shipped with the source package.
- `provider-agent-skills.observed.json` records provider-native agent skills separately from BlackRoad's six repository agent profiles.
- Full `SKILL.md` bodies remain in their package directories and are not embedded in public catalog responses.

## Repository-native skills

### road-gateway-backend

Owns gateway registry, health semantics, authority routing, adapter metadata, repair queues, and governance handoffs. It must not absorb ordinary provider tasks that belong to a connected provider tool.

### road-connected-provider

A disciplined fallback for provider operations when no narrower provider-specific skill owns the task. It resolves account context, classifies authority, executes narrowly, verifies writes, and preserves failure semantics.

Both packages include eight semantic evaluation families and a progressive reference larger than 1,000 bytes.

## Verification

```bash
node scripts/check-repository-skills.mjs
node scripts/check-backend-schemas.mjs
npm test
```

A route entry proves routing metadata exists. It does not prove the app is connected, an account is provisioned, or the current actor may execute the operation.
