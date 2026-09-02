#!/usr/bin/env bash

set -euo pipefail

APPLY=0
REPLACE=0
WORKSPACE="/Users/alexa/workspace"

usage() {
  cat <<'EOF'
Usage:
  ./install-workspace.sh [--workspace PATH] [--apply] [--replace]

Default behavior is a dry run.

Options:
  --workspace PATH  Install beneath this workspace root.
  --apply           Perform the installation.
  --replace         Replace an existing runtime after creating a timestamped backup.
  --help            Show this help.

The installer does not edit global Claude configuration and never copies provider secrets.
EOF
}

while (($#)); do
  case "$1" in
    --workspace)
      shift
      [[ $# -gt 0 ]] || { printf '%s\n' 'missing value for --workspace' >&2; exit 64; }
      WORKSPACE="$1"
      ;;
    --apply)
      APPLY=1
      ;;
    --replace)
      REPLACE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORKSPACE="$(mkdir -p -- "$WORKSPACE" && CDPATH= cd -- "$WORKSPACE" && pwd)"
SYSTEM_ROOT="$WORKSPACE/system"
TARGET="$SYSTEM_ROOT/messaging"
STATE_ROOT="$WORKSPACE/.road-agents/shared/messaging"
PROFILE_ROOT="$TARGET/mcp/claude"

required=(
  package.json
  framework.mjs
  agent-mcp-server.mjs
  webhook-server.mjs
  launch-agent-mcp.sh
  mcp/claude/agent-instance-1.json
  mcp/claude/agent-instance-2.json
  mcp/claude/agent-instance-3.json
  mcp/claude/agent-instance-4.json
  mcp/claude/agent-instance-5.json
  mcp/claude/agent-instance-6.json
  mcp/claude/connector-orchestrator.json
)

for relative in "${required[@]}"; do
  [[ -f "$SCRIPT_DIR/$relative" ]] || {
    printf 'required source file missing: %s\n' "$SCRIPT_DIR/$relative" >&2
    exit 66
  }
done

cat <<EOF
BlackRoad messaging workspace installation
mode:          $([[ "$APPLY" -eq 1 ]] && printf apply || printf dry-run)
source:        $SCRIPT_DIR
target:        $TARGET
state:         $STATE_ROOT
replace:       $([[ "$REPLACE" -eq 1 ]] && printf yes || printf no)
global config: unchanged
secrets:       not copied
EOF

if [[ "$APPLY" -eq 0 ]]; then
  cat <<EOF

No files changed.
Apply with:
  "$SCRIPT_DIR/install-workspace.sh" --workspace "$WORKSPACE" --apply

Claude profile examples after installation:
  $TARGET/mcp/claude/agent-instance-1.json
  $TARGET/mcp/claude/agent-instance-2.json
  $TARGET/mcp/claude/agent-instance-3.json
  $TARGET/mcp/claude/agent-instance-4.json
  $TARGET/mcp/claude/agent-instance-5.json
  $TARGET/mcp/claude/agent-instance-6.json
  $TARGET/mcp/claude/connector-orchestrator.json
EOF
  exit 0
fi

mkdir -p -- "$SYSTEM_ROOT" "$WORKSPACE/.road-agents/shared"
chmod 700 "$WORKSPACE/.road-agents" "$WORKSPACE/.road-agents/shared" 2>/dev/null || true

if [[ -e "$TARGET" && "$REPLACE" -ne 1 ]]; then
  printf 'target already exists: %s\n' "$TARGET" >&2
  printf '%s\n' 'rerun with --replace to create a backup and install the new runtime' >&2
  exit 73
fi

STAGE="$(mktemp -d "$SYSTEM_ROOT/.messaging-install.XXXXXX")"
BACKUP=""
cleanup() {
  [[ -z "${STAGE:-}" || ! -e "$STAGE" ]] || rm -rf -- "$STAGE"
}
trap cleanup EXIT INT TERM

cp -R -- "$SCRIPT_DIR/." "$STAGE/"
chmod 755 "$STAGE/launch-agent-mcp.sh" "$STAGE/install-workspace.sh"

for profile in "$STAGE"/mcp/claude/*.json; do
  python3 - "$profile" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
json.loads(path.read_text())
PY
done

(
  cd "$STAGE"
  npm run verify
)

if [[ -e "$TARGET" ]]; then
  BACKUP="$SYSTEM_ROOT/messaging.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e "$BACKUP" ]] || { printf 'backup path already exists: %s\n' "$BACKUP" >&2; exit 73; }
  mv -- "$TARGET" "$BACKUP"
fi

mv -- "$STAGE" "$TARGET"
STAGE=""
mkdir -p -- "$STATE_ROOT"
chmod 700 "$STATE_ROOT"

RECEIPT="$STATE_ROOT/install-receipt.json"
python3 - "$RECEIPT" "$WORKSPACE" "$TARGET" "$BACKUP" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
receipt, workspace, target, backup = sys.argv[1:]
payload = {
    "schema": "road-messaging-install-receipt-v1",
    "installedAt": datetime.now(timezone.utc).isoformat(),
    "workspace": workspace,
    "target": target,
    "backup": backup or None,
    "globalClaudeConfigChanged": False,
    "providerSecretsCopied": False,
    "verification": "npm run verify",
}
Path(receipt).write_text(json.dumps(payload, indent=2) + "\n")
PY
chmod 600 "$RECEIPT"

cat <<EOF

Installed successfully.
runtime:       $TARGET
state:         $STATE_ROOT
receipt:       $RECEIPT
backup:        ${BACKUP:-none}

Review one profile and merge it into the matching Claude instance manually:
  $PROFILE_ROOT/agent-instance-1.json
  $PROFILE_ROOT/agent-instance-2.json
  $PROFILE_ROOT/agent-instance-3.json
  $PROFILE_ROOT/agent-instance-4.json
  $PROFILE_ROOT/agent-instance-5.json
  $PROFILE_ROOT/agent-instance-6.json
  $PROFILE_ROOT/connector-orchestrator.json
EOF
