# BlackRoad Messaging Fabric

A provider-neutral discussion and comment layer for BlackRoad agents. It normalizes thread identities, plans provider-native operations, preserves collaboration claims and receipts, and prevents cross-provider mirror loops.

## Scope

The framework models threads, replies, edits, deletions, reactions, resolution, mentions, attachments by reference, and one-way provider projections. Provider credentials never enter this package. Provider calls still execute through authenticated native connectors or reviewed Chat SDK adapters.

## Providers

Native connected surfaces: Slack, GitHub, Linear, Asana, Notion, Airtable.

Adapter-available surfaces requiring configuration: Microsoft Teams, Google Chat, Discord, Telegram, WhatsApp Business Cloud, Matrix.

## Verify

```bash
cd messaging
npm run verify
```

## Safety

Every write is `COMMUNICATE`, requires explicit approval evidence, an exact runtime session, a stable idempotency key, an exclusive destination claim, and provider-native read-after-write verification. Reactions are social signals, never governance authority. Bidirectional mirroring is disabled by default.
