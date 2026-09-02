# Road Conversation Fabric validation v0.10.0

Source verified from a fresh download of `BlackRoad-Network/blackroad-gateway-mesh@gateway-conversations-v1`.

- JSON contract parsing: PASS
- Node syntax checks: PASS
- Conversation runtime tests: 24 passed, 0 failed
- Read-only Netlify messaging function typecheck: PASS
- Platform contracts: 18
- Normalized operations: 33
- Repository-native semantic eval families: 10
- Provider messages sent during validation: 0
- Provider mutations during validation: 0
- Public message execution: disabled
- Automatic cross-posting: disabled
- Microsoft Teams: `ADAPTER_AVAILABLE_CONFIG_REQUIRED`
- Slack: `READ_VERIFIED_WRITE_TOOL_AVAILABLE`

The test suite covers explicit communication approval, administrative governance, draft-versus-send separation, stable Road identity, multi-provider bindings, unsupported operations, Teams configuration honesty, provider timeouts, read-after-write verification, exact runtime-session binding, duplicate-event rejection, own-echo rejection, bounded bridge hops, and raw-content exclusion from control state.
