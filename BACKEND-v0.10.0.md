# BlackRoad connector collaboration backend v0.10.0

Status: isolated MCP and queue slice implemented and verified locally; public deployment remains governance-blocked.

## First-class agent execution seam

This release adds a stdio MCP adapter that binds one logical BlackRoad agent and one exact runtime session at process startup. Connector-active Claude sessions can now use tools for workflow instantiation, queue inspection, work start/finish, delegation, notifications, and collaboration status without reconstructing the protocol from prose.

## Durable orchestration

Reviewed workflow templates instantiate into dependency-aware work items. Ready work emits durable addressed notifications. Mutating work is exclusive per logical agent and exact resource, and remains session-bound through completion. Successful mutation requires read-after-write verification evidence. `TIMEOUT_UNKNOWN` never unlocks downstream work.

## Transport and persistence

JSON-RPC requests are processed through a serialized promise chain because Node event listeners do not await asynchronous handlers. The local store adds inter-process locking, atomic state replacement, generation numbers, secret rejection, and hash-chained events.

## Delegation

Delegation has an explicit source, target, contract reference, acceptance evidence, and lifecycle. Ownership changes only after target acceptance. A second Claude session cannot inherit the first session's mutation authority.

## MCP tools

- `road_collab_session_heartbeat`
- `road_collab_status`
- `road_collab_workflow_templates`
- `road_collab_workflow_instantiate`
- `road_collab_queue_list`
- `road_collab_work_item_start`
- `road_collab_work_item_finish`
- `road_collab_delegation_create`
- `road_collab_delegation_resolve`
- `road_collab_notifications_list`
- `road_collab_notification_ack`

## New contracts

- `collaboration/work-item.schema.json`
- `collaboration/delegation.schema.json`
- `collaboration/notification.schema.json`
- `collaboration/mcp/tool-manifest.json`
- `collaboration/mcp/server.mjs`
- `collaboration/mcp/lib/store.mjs`
- `collaboration/mcp/lib/broker.mjs`

## Verification

The isolated source package passed its MCP syntax and behavioral suite, including workflow idempotency, dependency blocking, read-after-write enforcement, exact session ownership, explicit delegation acceptance, notification ownership, timeout ambiguity, secret rejection, conflicting starts, and serialized stdio ordering.

## Safety state

Provider execution remains provider-native. No provider credential enters the broker. No live Tailscale policy, public deployment, Funnel exposure, financial operation, DNS mutation, or ChatGPT app permission is changed by this slice. Neura remains the deployment gate.
