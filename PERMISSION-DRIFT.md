# Plugin permission drift

Observed September 2, 2026. This is a read-only posture report. No ChatGPT app permission was changed by this backend pass.

## High drift

- Netlify: actual `full_access`; repository recommendation `always_ask`.
- GitHub: actual `full_access`; repository recommendation `review_important_actions`.

## Medium drift

- Neura Relay MCP: actual `full_access`; recommendation `ask_before_writes`.
- DigitalOcean: inherits the global `review_important_actions` setting; recommendation `always_ask`.
- Stripe: inherits global; recommendation `always_ask`.
- Webflow: inherits global; recommendation `always_ask`.
- WorkOS: inherits global; recommendation `always_ask`.

## Aligned

- Resend inherits global `review_important_actions`, matching the repository recommendation.

## Connection distinction

- 1Password and Tailscale skills are installed, but the ChatGPT apps were not installed when inspected. Their local/skill availability must not be reported as an active ChatGPT app permission.

## Rule

Actual permission changes require an explicit target and explicit mode. Backend configuration may report drift and recommend a mode, but it must not invent consent.
