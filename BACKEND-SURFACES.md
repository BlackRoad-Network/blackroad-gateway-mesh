# Backend surface observation

Observed on 2026-09-02. Re-observe before making decisions that depend on current app permissions or callable write tools.

## Connected apps with custom allow-all posture

- GitHub
- Netlify
- Linear
- Neura Relay MCP
- Slack

This app-level posture still does not override provider authorization, target confirmation, repository controls, billing/security permissions, or Neura decisions.

## Connected apps using the global low-risk default

- PostHog
- Resend
- Vercel
- Railway
- Supabase
- Notion
- Airtable
- OpenAI Platform
- Hugging Face
- DigitalOcean

## Skill available, hosted app not installed

- Tailscale
- 1Password
- NVIDIA
- Proxyman
- ZzzOps

These remain useful local or repository execution bridges. They are not account connections in this hosted session.

## Current surface anomalies

- GitHub app permission allows actions, but the observed refreshed callable surface was read-only. New local work must not be described as committed without a successful connector write receipt.
- Linear app permission allows actions, but the observed refreshed callable surface was read-only.
- Linear returned zero configured Agent skills successfully. Status is `READY_EMPTY`, not disconnected.
- Netlify has a write surface, but public gateway deployment remains `POLICY_BLOCKED` by Neura.

Canonical machine-readable observation:

```text
plugins/platform-permissions.observed.json
skills/provider-agent-skills.observed.json
```
