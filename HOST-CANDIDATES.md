# Gateway host candidates

Observed from the connected DigitalOcean control plane. No infrastructure change was made.

## codex-infinity

- State: active
- Public IPv4: `159.65.43.12`
- Private IPv4: `10.108.0.2`
- 4 vCPU / 8 GB RAM
- Backups enabled
- Monitoring enabled
- Private networking enabled
- Candidate role: primary cloud-side BlackRoad gateway/service host, subject to SSH/Tailscale/listener verification

## shellfish-droplet

- State: active
- Public IPv4: `174.138.44.45`
- Private IPv4: `10.116.0.2`
- 1 vCPU / 1 GB RAM
- Private networking enabled
- Candidate role: lightweight relay/secondary service host, not preferred for the full gateway control plane without resource verification

## Rule

A DigitalOcean droplet being active does not prove that Tailscale, SSH, or a BlackRoad gateway listener is installed or healthy. Agent-instance-1 must verify transport/listener state before either node is advertised as a Tailscale Service host.
