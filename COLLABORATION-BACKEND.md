# BlackRoad collaboration backend

The collaboration broker coordinates one connector orchestrator and six Claude workspace agents without pretending that shared access means shared authority.

## Identity

- Canonical service: `road://service/collaboration`
- Alias: `road://collaboration`
- Private service identity: `svc:collaboration`
- Durable target: Netlify Blobs with strong reads and compare-and-swap writes
- Local mirror target: `/Users/alexa/workspace/.road-agents/shared/collaboration`

## Action classes

`OBSERVE`, `READ`, `WRITE`, `COMMUNICATE`, `DEPLOY`, `ADMIN`, `SECRET`, and `PUBLIC_EXPOSE`.

Mutating classes require idempotency keys. Deploy, admin, secret, and public-exposure classes require governance. External communication, secrets, and public exposure also require explicit user approval evidence.

## Coordination objects

- intents
- claims
- handoffs
- receipts
- conflicts
- heartbeats
- hash-chained events

Reads may overlap. Writes may not. Each agent may hold at most one active exclusive mutation, and each resource may have at most one active exclusive claim.

## Signed request boundary

Private collaboration routes require an HMAC-signed request binding:

- method
- request path
- body hash
- agent identity
- timestamp
- nonce

Nonces cannot be replayed. Secret values and secret-looking fields are rejected from collaboration state. Public protocol and agent metadata omit secret references.

## Failure semantics

`TIMEOUT_UNKNOWN` remains unknown. It is not converted to failed or offline. Conflicts are recorded instead of being silently erased, and handoffs can only be acknowledged by their intended recipients.

## Connector boundary

The collaboration broker coordinates authorization and ownership. Provider actions still execute through provider-native connectors and provider-native authentication. The broker is not an unauthenticated universal reverse proxy, despite that being the sort of idea people tend to have five minutes before an incident report.
