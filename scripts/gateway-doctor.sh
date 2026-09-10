#!/usr/bin/env bash
set -euo pipefail

BASE="${ROAD_GATEWAY_URL:-}"
if [[ -z "$BASE" ]]; then
  echo "ROAD_GATEWAY_URL is required; refusing to assume a public deployment exists." >&2
  exit 64
fi
BASE="${BASE%/}"

fail=0
check() {
  local path="$1"
  local expected="${2:-200}"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 "$BASE$path" || true)"
  if [[ "$code" == "$expected" ]]; then
    printf 'PASS %-36s HTTP %s\n' "$path" "$code"
  else
    printf 'FAIL %-36s HTTP %s expected %s\n' "$path" "${code:-000}" "$expected" >&2
    fail=1
  fi
}

check /gateway
check /gateway/services
check /gateway/health
check /gateway/capabilities
check /gateway/services/github
check /gateway/services/does-not-exist 404

if [[ "$fail" -ne 0 ]]; then
  echo "GATEWAY_DOCTOR_FAILED" >&2
  exit 1
fi

echo "GATEWAY_DOCTOR_OK"
