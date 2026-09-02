# Road gateway command contract

The gateway is a resolver and authority-aware connector directory, not an unauthenticated reverse proxy.

```text
road gateway show
road gateway health
road gateway services
road gateway capabilities
road gateway resolve road://service/identity

road connector list
road connector show github
road connector health github
road connector capabilities github
road connector route github
road connector auth github
```

## Required semantics

- `list` and `show` are metadata reads.
- `health` reports observed state and preserves UNKNOWN/TIMEOUT distinctions.
- `capabilities` describes what a connector can do, not what the current actor may do.
- `route` resolves the current service/provider route without exposing credentials.
- `auth` reports authentication posture; it must never print secret values.
- Provider writes require a separate capability decision and provider-native authorization.
