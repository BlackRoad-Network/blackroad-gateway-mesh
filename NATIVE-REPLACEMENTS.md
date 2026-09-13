# RoadOS native replacement control plane

External services are bridges into RoadOS. They are not the product, the identity authority, or the permanent home of BlackRoad-owned data.

The native registry keeps the product surface intentionally small:

1. Search
2. Chat
3. Code
4. Work
5. Play
6. Design
7. Integrate
8. Collaborate

Provider-specific behavior is mapped to a literal capability inside one of those eight surfaces. For example, Gmail, Outlook Email, and Resend all bridge to **Chat / Email**; GitHub bridges to **Code / Source**; Figma bridges to **Design / Design**; Cloudflare, Netlify, Railway, Vercel, and DigitalOcean bridge to owned capabilities inside **Integrate**.

The app-surface registry separately records every app/plugin family visible to the current execution context. It currently maps 68 app families into 53 owned capabilities without claiming that tool availability proves account authentication.

## Native exit gate

A provider remains a bridge until the native capability has fresh evidence for:

- BlackRoad-owned storage
- local read behavior
- local write behavior when the capability supports writes
- provider-neutral import and export
- safe provider disconnect
- tested rollback
- operation receipts

`contracted`, `scaffolded`, or merely connected is not native-complete. Only a `verified` capability with every required evidence item can become `native-preferred`.

## Commands

```bash
node bin/road-connectors.mjs native status
node bin/road-connectors.mjs native describe outlook-email
node bin/road-connectors.mjs native plan outlook-email
node bin/road-connectors.mjs native plan adapter-plane \
  --evidence=owned-storage \
  --evidence=local-read \
  --evidence=local-write \
  --evidence=provider-neutral-import \
  --evidence=provider-neutral-export \
  --evidence=provider-disconnect \
  --evidence=rollback-tested \
  --evidence=operation-receipts
```

The registry stores no credentials, tokens, account identifiers, mailbox contents, or provider payloads.
