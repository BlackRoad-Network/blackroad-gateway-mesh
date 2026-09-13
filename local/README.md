# Run the gateway locally

From the repository root, with Node 22.18+ or Node 24+:

```sh
node local/server.mjs
```

Open `http://127.0.0.1:1729`. No npm install, build command, Netlify account,
provider token, or external HTTP request is required. Node supplies its built-in
TypeScript loader. Set `ROAD_GATEWAY_PORT` to change the loopback port.

The server runs the existing gateway and messaging Fetch handlers and serves only
the existing index page and their routes. It does not expose the repository as a
file server. Other files return 404, malformed service IDs return 400, and mutation
requests return 405. The server binds only to loopback.

Gateway status and endpoint values come from the existing `ROAD_GATEWAY_*`
environment variables. Missing statuses remain `UNKNOWN`; listing a connector
does not establish that it works. No service is contacted by these handlers.
The optional Netlify deployment continues to read its platform environment.

```sh
node --test local/*.test.mjs messaging/*.test.mjs
```

The local test opens a real loopback socket and checks registry, health,
capabilities, messaging discovery, HEAD, method rejection and path boundaries.
Existing messaging permission, approval, receipt and event tests run unchanged.

This replaces mandatory Netlify hosting for the gateway's read-only HTTP surface
and removes its type-only npm package. It does not implement the provider services
listed by the registry or move deployed production traffic. Node and the host OS
remain dependencies. TLS, remote ingress and deployment supervision are outside
this local server.
