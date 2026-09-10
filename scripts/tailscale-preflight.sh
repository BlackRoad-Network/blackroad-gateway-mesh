#!/usr/bin/env bash
set -euo pipefail

printf '== BlackRoad Tailscale gateway preflight ==\n'
command -v tailscale >/dev/null || { echo 'TAILSCALE_MISSING'; exit 2; }
tailscale version | head -1
printf '\n-- status --\n'
tailscale status || true
printf '\n-- serve status --\n'
tailscale serve status || true
printf '\n-- existing service config --\n'
tailscale serve get-config --all - 2>/dev/null || true
printf '\n-- candidate local listeners --\n'
for port in 1729 3000 4222 4771 11434; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -3 | grep -q .; then
    echo "LISTENING tcp:$port"
  else
    echo "NO_CONFIRMED_LISTENER tcp:$port"
  fi
done
printf '\nNo configuration was changed.\n'
