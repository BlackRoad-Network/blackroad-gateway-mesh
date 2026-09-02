# Connector collaboration runtime

The collaboration plane is a local control service used by Claude, ChatGPT, Codex, Roadie, and approved human-operated sessions before connector mutations.

## Boundaries

- Stable authority identity: `road://agent/agent-instance-N`
- Ephemeral runtime session: `session_<uuid>`
- Runtime and model names are provenance, never authority.
- Provider credentials remain inside provider-native authentication or a local secret manager.
- The collaboration service coordinates work but does not become a universal credential proxy.

## Start the daemon

```bash
node collaboration/daemon.mjs
```

Convenience launcher:

```bash
sh bin/road-collabd
```

Default socket resolution order:

```text
$ROAD_COLLAB_SOCKET
$XDG_RUNTIME_DIR/blackroad/road-collab.sock
/tmp/blackroad-<uid>/road-collab.sock
```

The socket directory is private and the socket is created with mode `0600`.

## Claude / MCP

Configure Claude to launch:

```text
node /absolute/path/to/collaboration/mcp-server.mjs
```

or:

```text
sh /absolute/path/to/bin/road-collab-mcp
```

Required environment:

```text
ROAD_AGENT_ID=agent-instance-1..6
ROAD_AGENT_RUNTIME=claude
ROAD_AGENT_MODEL=<provenance only>
ROAD_COLLAB_SOCKET=<daemon socket>
```

The MCP server exposes registration, dispatch planning, workflow planning, claim reservation, completion, typed handoff, acknowledgement, status, and reconciliation tools.

## Connector mutation lifecycle

```text
PLAN
  -> HANDOFF OR DELEGATION WHEN DOMAIN OWNER DIFFERS
  -> AUTHORITY GATES
  -> EXCLUSIVE CLAIM
  -> PROVIDER-NATIVE EXECUTION
  -> VERSION VERIFICATION
  -> RESULT NORMALIZATION
  -> RECEIPT
  -> WORKFLOW VALIDATION
```

A timeout becomes `TIMEOUT_UNKNOWN`. It must be reconciled against provider state before retry. A successful zero-result read becomes `EMPTY_OBSERVATION`. Connector success completes one step, not the entire workflow.

## Multi-connector workflows

`workflow.plan` builds a DAG, refuses cycles, serializes mutations against the same canonical connector resource, and emits cross-agent handoffs. Parallel waves contain only dependency-safe work. Planning never invokes a provider.

## Connector planes

The source, work-graph, registry, documentation, notification, governance, secret, private-network, public-edge, and telemetry planes remain distinct. A provider may participate in several workflows, but no successful API response promotes it into a different authority plane.
