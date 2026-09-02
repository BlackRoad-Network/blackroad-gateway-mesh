# Install the verified collaboration backend in `/Users/alexa/workspace`

The public branch contains the collaboration protocol, skill, schemas, agent profiles, and stewardship rules. The exact executable v0.7.1 package is retained as a verified private artifact so concurrent agents do not reconstruct a different broker implementation from the public contract.

Expected private artifact title:

`blackroad-plugin-gateway-v0.7.1.tar.gz`

Expected SHA-256:

`cca34be81940f35dd2d7befa4368ac877465593cc151687c9fd704f063046f26`

## Installation rule

An agent must not substitute a newly generated collaboration runtime if the exact verified artifact is unavailable. Report `ARTIFACT_UNAVAILABLE` and continue read-only work instead.

When the artifact is available locally, install from the exact bytes only after verifying the checksum:

```bash
set -euo pipefail

WORKSPACE=/Users/alexa/workspace
ARCHIVE="$WORKSPACE/blackroad-plugin-gateway-v0.7.1.tar.gz"
EXPECTED=cca34be81940f35dd2d7befa4368ac877465593cc151687c9fd704f063046f26

ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[ "$ACTUAL" = "$EXPECTED" ] || {
  printf 'CHECKSUM_MISMATCH expected=%s actual=%s\n' "$EXPECTED" "$ACTUAL" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -xzf "$ARCHIVE" -C "$TMP"
ROOT="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$ROOT" ] || { echo 'ARCHIVE_ROOT_MISSING' >&2; exit 1; }

(
  cd "$ROOT"
  npm run verify
)
```

After verification, integrate into the canonical workspace without deleting unrelated workspace state. Do **not** use an unconstrained `rsync --delete` against `/Users/alexa/workspace`.

Recommended canonical package destination:

```text
/Users/alexa/workspace/blackroad-plugin-gateway
```

Canonical collaboration CLI link:

```text
/Users/alexa/workspace/bin/road-collab
```

Canonical shared bootstrap document:

```text
/Users/alexa/workspace/.road-agents/shared/COLLABORATION.md
```

Canonical collaboration state directory:

```text
/Users/alexa/workspace/.road-agents/shared/collaboration/
```

## Concurrent-agent safety

Before replacing an existing package destination:

1. run `git status` if the destination is a repository;
2. inspect current branch/worktree ownership;
3. inspect the shared collaboration state for active exclusive claims;
4. refuse replacement when uncommitted or actively claimed files would be overwritten;
5. use an isolated worktree or a versioned staging directory when reconciliation is required;
6. verify the installed package after integration;
7. record an installation receipt and handoff to all active Claude agents.

## Per-agent activation

Each connector-active Claude session should begin with a unique session reference:

```bash
/Users/alexa/workspace/bin/road-collab heartbeat \
  --agent agent-instance-N \
  --runtime claude-workspace \
  --provider anthropic \
  --session-ref SESSION_REF

/Users/alexa/workspace/bin/road-collab status
/Users/alexa/workspace/bin/road-collab view --agent agent-instance-N
```

The same `SESSION_REF` must remain attached to mutating intent, claim, execution, invocation, verification, and receipt commands for that operation.

## Provider writes

Do not call an externally consequential provider tool until the collaboration preflight succeeds. After the provider call, perform provider-native read-back and record verification before issuing a successful BlackRoad receipt.

The collaboration plane coordinates provider execution. It never carries provider credentials and never turns broad application permissions into BlackRoad authority.
