# BlackRoad Messaging Framework

This stacked branch adds a provider-neutral messaging and discussion plane on top of the existing gateway and collaboration work.

Canonical service:

```text
road://service/messaging
```

Supported connected-tool surfaces:

- Slack channels, messages, threads, edits, deletion, reactions, search, and files
- GitHub PR and issue conversation comments, inline review threads, edits, reactions, and resolution
- Linear issue/project/document discussions and diff-review threads
- Asana task comments
- Notion page and block discussions
- Airtable record comments and threaded replies

Planned Vercel Chat SDK adapters:

- Microsoft Teams
- Slack
- Discord
- Google Chat
- GitHub
- Linear
- Telegram
- WhatsApp

The messaging layer does not proxy credentials or execute provider writes. It creates canonical threads, plans provider-native operations, fences them with collaboration authority, records provider outcomes, verifies writes through read-back, prevents mirror loops, and emits durable receipts.

No real Slack message, GitHub comment, Teams post, email, or other external communication was sent while validating this branch.
