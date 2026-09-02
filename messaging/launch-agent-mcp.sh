#!/usr/bin/env bash

set -euo pipefail

AGENT_ID="${1:-${ROAD_AGENT_ID:-}}"

case "$AGENT_ID" in
  connector-orchestrator|agent-instance-1|agent-instance-2|agent-instance-3|agent-instance-4|agent-instance-5|agent-instance-6)
    ;;
  *)
    printf 'invalid ROAD_AGENT_ID: %s\n' "${AGENT_ID:-<missing>}" >&2
    exit 64
    ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORKSPACE_ROOT="${ROAD_WORKSPACE_ROOT:-/Users/alexa/workspace}"
STATE_ROOT="${ROAD_MESSAGING_STATE_ROOT:-$WORKSPACE_ROOT/.road-agents/shared/messaging}"
HOST_ID="$(hostname 2>/dev/null || printf unknown-host)"
SESSION_REF="${ROAD_SESSION_REF:-messaging-mcp:${AGENT_ID}:${HOST_ID}:$$:$(date +%s)}"

export ROAD_AGENT_ID="$AGENT_ID"
export ROAD_SESSION_REF="$SESSION_REF"
export ROAD_WORKSPACE_ROOT="$WORKSPACE_ROOT"
export ROAD_MESSAGING_STATE_ROOT="$STATE_ROOT"

exec node "$SCRIPT_DIR/agent-mcp-server.mjs"
