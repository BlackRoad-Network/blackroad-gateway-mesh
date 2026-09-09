# BlackRoad Messaging / Transport Health v1.9.0

v1.9 adds read-only transport and edge health probes to the existing messaging and collaboration plane.

## New probes

- RNode: serial candidate discovery, `rnstatus rnode`, and read-only `rnodeconf <port> -i --nocheck` verification.
- Tailscale: `tailscale status --json` plus optional `tailscale ping --c=1 --timeout=5s --until-direct=false <target>`.
- ICMP ping: one bounded ping without inferring host absence from no reply.
- TCP: bounded listener check with separate refused, timeout, and unreachable states.
- DNS: resolver evidence only, never service-health inference.
- HTTP/Netlify URL: bounded HEAD reachability probe.

## Agent-facing surfaces

The exact v1.9 package wires these probes into the Road messaging CLI and Claude MCP via `health-probe`, `health-matrix`, `road_messaging_health_probe`, and `road_messaging_health_matrix`.

## State semantics

- No ICMP reply is `NO_ICMP_REPLY`, not `OFFLINE`.
- Tailscale timeout is `TIMEOUT_UNKNOWN`.
- An RNode serial candidate without a verified info response is not `VERIFIED`.
- A missing tool is `NOT_INSTALLED` / `TOOL_MISSING`, not proof that a service or device does not exist.
- HTTP checker transport failure is separate from destination unreachability.

## Verified release

- 113 tests passed
- 0 failed
- 70 MCP tools
- clean-extract verification passed
- no provider mutations during verification

Exact package SHA-256:

`230afad76ca3c4860691bd9ebc51f1b74ac1f9238bf26ca33744d1c23860c3cb`
