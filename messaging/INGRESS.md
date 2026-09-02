# Messaging ingress

Canonical service: `road://service/messaging`

Default local listener: `127.0.0.1:1731`

The ingress service receives signed Slack and GitHub webhook deliveries, normalizes provider events, writes reference-only durable state, routes matching items to exact agent sessions, and queues collaboration handoffs for the `road-collab` broker.

## Run locally

```bash
cd messaging
node webhook-server.mjs
```

The default state root is:

```text
/Users/alexa/workspace/.road-agents/shared/messaging
```

Supported environment references:

```text
ROAD_WORKSPACE_ROOT
ROAD_MESSAGING_STATE_ROOT
ROAD_SLACK_SIGNING_SECRET
ROAD_GITHUB_WEBHOOK_SECRET
```

Secret values must be injected at process launch through an approved secret provider. Do not write them into this repository, messaging state, receipts, logs, or agent handoffs.

## Routes

```text
GET  /health
GET  /status
POST /webhooks/slack
POST /webhooks/github
```

The server binds loopback only unless an explicit caller deliberately enables a non-loopback bind. The default service does not proxy provider calls and does not expose provider payloads through public status.

## Inbound flow

```text
raw request
  → bounded body read
  → provider signature verification
  → provider event normalization
  → event deduplication
  → atomic state transaction
  → thread/message/reaction state
  → agent subscription routing
  → reference-only handoff outbox
```

Slack URL-verification challenges are returned only after signature verification. Challenge values are not stored; only a hash reference is retained.

Providers routed through Chat SDK or another adapter must supply an adapter-owned verification attestation to the in-process normalization API. The public HTTP listener does not trust arbitrary client assertions that an adapter verified something.

## Public exposure

Do not expose this listener through Netlify, Funnel, a reverse proxy, public DNS, or a non-loopback bind until the deployment, network, and governance layers authorize the exact route. Public gateway deployment remains subject to the existing Neura decision.
