# BlackRoad Messaging Framework

A local-first, provider-neutral discussion plane for BlackRoad agents and connected communication surfaces.

## Verify

```bash
cd messaging
npm run verify
```

## Local CLI

```bash
export ROAD_MESSAGING_HOME=/Users/alexa/workspace/.road-agents/shared/messaging

./road-message init
./road-message status
./road-message capabilities --provider slack
./road-message doctor
```

Provider writes are never executed by this package. It plans exact provider-native operations, records provider outcomes, and requires read-after-write verification.

## Components

- `core.mjs`: canonical thread, message, binding, projection, reaction, and event semantics.
- `provider-plan.mjs`: exact provider-native operation and read-back plans.
- `store.mjs`: atomic local state and append-only event journal.
- `chat-sdk-bridge.mjs`: optional Vercel Chat SDK adapter loading for Teams, Slack, Discord, Google Chat, GitHub, Linear, Telegram, and WhatsApp.
- `mcp-server.mjs`: Claude-compatible MCP planning and state surface.
- `provider-capabilities.json`: observed and planned provider capabilities without account identifiers.
- `provider-policy.json`: authority, privacy, projection, and verification defaults.
- `schemas/`: durable public contracts.
- `tests/`: deterministic safety and lifecycle coverage.

## Connected-tool providers

The current normalized tool surface covers Slack, GitHub, Linear, Asana, Notion, and Airtable.

## Chat SDK providers

The optional bridge maps official Vercel Chat SDK adapters for Slack, Microsoft Teams, Google Chat, Discord, GitHub, Linear, Telegram, and WhatsApp. Adapter availability is distinct from authentication and action authority.
