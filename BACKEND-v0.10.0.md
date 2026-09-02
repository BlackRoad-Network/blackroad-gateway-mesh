# BlackRoad messaging and discussion backend v0.10.0

Status: implemented on the isolated `gateway-conversations-v1` branch; no provider messages sent.

## Added

- Canonical service `road://service/conversations` with aliases `road://messaging` and `road://service/messaging`.
- Private service identity `svc:conversations`.
- Eighteen provider/platform definitions.
- Thirty-three normalized conversation operations.
- Provider-neutral conversation, binding, event, operation-envelope, and delivery contracts.
- Stable Road conversation identities with multiple provider bindings.
- Exact collaboration-session binding for messaging mutations.
- Content-reference and content-hash control plane, with raw text and secrets rejected.
- Loop protection through provider-event deduplication, own-echo suppression, route traces, and bounded bridge hops.
- Read-after-write verification requirements and truthful `TIMEOUT_UNKNOWN` delivery state.
- Four cross-connector conversation workflow templates.
- Read-only Netlify metadata function under `/gateway/messaging`.
- `road-message` planning CLI. It does not invoke providers.
- Repository-native `road-conversation-fabric` skill with ten semantic evaluation families.

## Current provider posture

Slack channel discovery and history reads are verified. Slack write tools exist, but this release deliberately sends no message.

Microsoft Teams has an official Chat SDK adapter contract but no connected Teams app was observed, so its state is `ADAPTER_AVAILABLE_CONFIG_REQUIRED` rather than a fabricated success.

GitHub, Linear, Notion, Google Drive, Asana, Gmail, Resend, GitBook, SharePoint, Zoom Team Chat, and other providers retain explicit per-surface states and unsupported-operation results.

## Messaging operation classes

- `READ`: list, search, inspect, and read.
- `WRITE`: unsent draft lifecycle.
- `COMMUNICATE`: externally visible messages, replies, comments, reactions, edits, deletions, schedules, resolutions, mentions, and attachments.
- `ADMIN`: channels, subscriptions, and webhooks.

Every `COMMUNICATE` operation requires explicit user-approval evidence. Every `ADMIN` operation requires user approval plus governance evidence.

## Safety

- No unsolicited message, comment, reaction, channel, webhook, or email was created.
- No message content or provider credential enters public gateway metadata.
- Provider acknowledgement is not verified completion.
- Automatic cross-posting is disabled.
- Public gateway execution remains disabled.
- Existing Neura public-deployment STOP remains in force.
