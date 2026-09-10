# Gateway runtime test

The Netlify Edge handler was compiled locally with TypeScript and executed under Node with a mocked `Netlify.env` surface.

## Routes verified

- `GET /gateway` -> 200
- `GET /gateway/health` -> 200
- `GET /gateway/capabilities` -> 200
- `GET /gateway/services/github` -> 200, normalized `READY`
- `GET /gateway/services/windsor-ai` -> 200, preserved `TIMEOUT_UNKNOWN`
- `GET /gateway/services/does-not-exist` -> 404

## Census

- 56 service definitions in the gateway source at test time.
- The test intentionally supplied only a small mocked environment subset, so unprovided connectors remained `UNKNOWN` rather than being fabricated as offline.

Result: `HTTP_ROUTE_TESTS_OK`.
