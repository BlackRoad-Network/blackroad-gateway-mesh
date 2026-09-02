# BlackRoad Messaging Framework v1.0.0

Status: verified local-first messaging and provider-projection backend.

## Capabilities

- spaces, threads, replies, edits, tombstones, reactions, mentions, read markers, and unread counts;
- typed messages for comments, questions, answers, decisions, status, blockers, handoffs, reviews, and system events;
- provider projections for Slack, GitHub, Microsoft Teams, Linear, Notion, Gmail, and Resend;
- provider-native delivery lifecycle with collaboration intent/claim references and read-after-write verification;
- timeout preservation as `TIMEOUT_UNKNOWN`;
- bridge-loop prevention and inbound deduplication;
- local CLI, loopback HTTP daemon on port 1731, and Claude-compatible MCP server;
- atomic state writes, hash-chained events, append-only receipts, and secret-material rejection.

## Verified state

- 27 automated tests passed;
- 7 provider adapters;
- 8 schemas;
- 12 MCP tools;
- clean temporary-workspace installation passed;
- no provider call, public deployment, or global configuration mutation occurred during verification.

Microsoft Teams is modeled as `CONNECTOR_UNAVAILABLE` until an authenticated connector is actually installed. Slack and GitHub are the currently available interactive discussion providers.
