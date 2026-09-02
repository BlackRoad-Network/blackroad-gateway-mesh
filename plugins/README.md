# Plugin backend

BlackRoad stores two independent permission views:

1. `permission-policy.json` is the recommended BlackRoad authority policy.
2. `platform-permissions.observed.json` is a timestamped observation of actual ChatGPT app settings and current tool-surface posture.

Neither file grants provider authority. Provider roles, target-level confirmation, repository rules, account modes, and Neura decisions remain enforceable.

## Current distinctions

- `INSTALLED` app is not the same as an installed skill pack.
- `NOT_INSTALLED` app may still have a local skill for CLI or desktop execution.
- `ALLOW_ALL_ACTIONS` at the ChatGPT app layer does not confer provider admin rights.
- `SURFACE_UNAVAILABLE` means the observed tool refresh did not expose the needed operation; it is not evidence of revoked provider access.
- `READY_EMPTY` means a successful provider read returned no configured resources.

## Generated files

The observation and policy files are generated from source modules. Run:

```bash
npm run config
npm run check
```

Do not hand-edit generated JSON without changing the source module first, or the drift check will object. It is one of the few forms of complaining that is actually useful.
