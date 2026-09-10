#!/usr/bin/env bash
set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 64
fi

command -v tailscale >/dev/null || { echo "TAILSCALE_MISSING" >&2; exit 2; }

if command -v lsof >/dev/null 2>&1; then
  if ! lsof -nP -iTCP@127.0.0.1:1729 -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .; then
    echo "REFUSING: no confirmed listener on 127.0.0.1:1729" >&2
    exit 3
  fi
else
  echo "REFUSING: lsof unavailable; listener cannot be independently confirmed" >&2
  exit 4
fi

cmd=(tailscale serve --service=svc:identity --tcp=1729 tcp://127.0.0.1:1729)
printf 'candidate:'
printf ' %q' "${cmd[@]}"
printf '\n'

if [[ "$APPLY" -ne 1 ]]; then
  echo "DRY_RUN_ONLY: re-run with --apply after reviewing current tailnet policy and service ownership."
  exit 0
fi

"${cmd[@]}"
tailscale serve status
