# All-Connector Integration Handoff

Target: merge the v1.9 all-connector fabric into the live messaging runtime without discarding newer v1.7+ federation work.

## Canonical source artifact

`blackroad-messaging-framework-v1.9.0.tar.gz` is clean-extract verified with 119 tests.

## Integration rule

Do not replace the active messaging branch wholesale. Reconcile these v1.9 additions into the current branch:

- `messaging/connector-fabric.json`
- `messaging/connector-fabric.mjs`
- `messaging/schemas/connector-fabric.schema.json`
- CLI connector-fabric/status/plan commands
- loopback `/connector-fabric*` routes
- Claude MCP connector-fabric/status/plan tools
- connector-fabric checks and tests
- road-messaging skill triggers/evals

Preserve any newer federation, ingress, provider-binding, mirror-repair, authenticity, and self-echo work already present on `gateway-messaging-v1`.

## Safety

No connector write should be performed merely to test the integration. Provider-native writes remain collaboration-gated and read-after-write verified.
