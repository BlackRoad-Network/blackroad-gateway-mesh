# Slack orchestration cockpit

Slack is the temporary live cockpit for BlackRoad orchestration. RoadOS remains the canonical authority, policy, identity, workflow, and receipt layer.

## Topology

```text
Alexa / agents
      |
      v
Slack #agent-hub
      |
      v
Roadie intent + policy + claim
      |
      +--> GitHub provider adapter
      |
      +--> Tailscale private transport --> Ollama worker
      |
      +--> other provider-native connectors
      |
      v
read-after-write verification --> RoadOS receipt --> Slack thread
```

## Exact live bindings

- Workspace: `road+connector://slack/workspace/T09BC6BSEDV`
- Cockpit space: `road+connector://slack/channel/C0A2M4K8WLB` (`#agent-hub`)
- Canvas: `road+connector://slack/canvas/F0C0GUEDXL6`
- GitHub integration repository: `road+connector://github/repository/BlackRoad-Network/blackroad-gateway-mesh`
- Model route: `road://service/models`
- Tailscale service: `svc:models`
- Ollama listener candidate: `127.0.0.1:11434`

The Slack kickoff message was read back successfully at provider message ID `1788943756.716919`.

## Command grammar

One operation belongs to one Slack parent message and thread.

- `road status <target>`
- `road plan <goal>`
- `road run <approved-plan>`
- `road verify <operation>`
- `road receipt <operation>`
- `road stop <operation>`
- `road reconcile <operation>`
- `road handoff <owner> <operation>`

Commands are normalized into the existing collaboration intent, invocation, verification, handoff, and receipt schemas. This directory does not replace those contracts.

GitHub pull-request events are classified as `OPENED`, `READY`, `UPDATED`, `MERGED`, or `CLOSED`. Unsupported actions fail closed. Delivery IDs remain traceable while semantic keys deduplicate provider redelivery of the same PR state.

The delivery planner emits exactly one of:

- `PARENT` when no canonical PR marker is recorded;
- `THREAD` with the exact existing Slack timestamp when a parent exists;
- `NOOP_DUPLICATE_*` when either the provider delivery or semantic event is already recorded.

Keys are recorded only after the provider write is read back and verified.

## Provider roles

| Provider | Role | Current state |
|---|---|---|
| Slack | cockpit / discussion | outbound write and read-back verified |
| GitHub | code + PR event source | event route enabled for this repository |
| Tailscale | private service transport | contract defined; live tailnet state not observed in this connector session |
| Ollama | private model worker | blocked until a node, listener, model inventory, and bounded inference are verified |
| Roadie | orchestrator | selects an allowed connector/worker; never hard-codes authority |
| Forgejo/Gitea | canonical source target | GitHub may transport or mirror; it does not replace `git.blackroad.systems` |
| 1Password | secret reference | values never enter Slack, GitHub, or receipts |

## Safety invariants

1. Unknown commands and connectors fail restrictive.
2. Slack message authorship is not sufficient authority for high-risk actions.
3. Reads may run automatically.
4. Writes require exact target and explicit execution intent.
5. Destructive, administrative, financial, secret, identity, access-control, merge, deploy, and public-exposure actions require stronger reviewed approval.
6. Tailscale uses grants, tailnet-only visibility, and no implicit Funnel.
7. Ollama never silently falls back to a public or paid model.
8. Provider acknowledgement is not success. Mutations require provider-native read-back.
9. `TIMEOUT_UNKNOWN` is reconciled before retry.
10. Secrets and sensitive prompt bodies are excluded from logs and receipts.

## Verification

Run from this repository:

```bash
node --test orchestration/slack-control-plane.test.mjs
```

This verifies the public-safe manifest and pure routing policy. It does not claim a live Tailscale node or Ollama process exists.
