# Gateway observability contract

PostHog is an observability adapter for gateway metadata and behavior. It is not the authority source for identity, permissions, routing, or connector truth.

## Candidate metadata events

- `road.gateway.resolve`
- `road.gateway.health`
- `road.connector.probe`
- `road.connector.status_changed`
- `road.gateway.decision`

## Safe fields

Events may include non-secret metadata such as:

- connector id
- Road URI
- normalized status
- previous normalized status
- capability name
- locality
- latency bucket
- result category
- governance receipt reference
- route class

## Prohibited fields

Never send:

- passwords
- API keys
- bearer tokens
- OAuth refresh tokens
- SSH private keys
- session cookies
- email message bodies
- private document contents
- raw provider payloads merely for debugging convenience

## Current PostHog state

The connected BlackRoad OS PostHog organization currently has no managed reverse proxy configured. Do not invent a proxy endpoint or DNS record until one is intentionally provisioned.

## Authority boundary

A PostHog event is evidence that something was observed. It is not proof that an actor was authorized, a connector is canonical, or a service identity is trustworthy. Those decisions remain in BlackRoad identity/capability state and the applicable governance layer.
