import type { Config, Context } from "@netlify/edge-functions";

type GatewayClass =
  | "network"
  | "hosting"
  | "developer"
  | "data"
  | "ai"
  | "productivity"
  | "identity"
  | "governance"
  | "observability"
  | "communications"
  | "documents"
  | "domain"
  | "local-bridge";

type Locality = "public" | "private" | "provider" | "local" | "hybrid";

type ServiceSpec = {
  env: string;
  id: string;
  label: string;
  class: GatewayClass;
  locality: Locality;
  capabilities: string[];
  roadUri?: string;
  tailscaleService?: string;
  endpointEnv?: string;
  statusEnv?: string;
};

const services: ServiceSpec[] = [
  { env: "NETLIFY_NETWORK_ATLAS", id: "netlify-network-atlas", label: "Netlify Network Atlas", class: "hosting", locality: "public", capabilities: ["http", "static-edge"] },
  { env: "TAILSCALE_SERVICES", id: "tailscale-services", label: "Tailscale Services", class: "network", locality: "private", capabilities: ["mesh", "service-identity", "serve", "tsnet"], roadUri: "road://service/network", tailscaleService: "svc:blackroad-gateway" },
  { env: "TAILSCALE_APERTURE", id: "tailscale-aperture", label: "Tailscale Aperture", class: "governance", locality: "private", capabilities: ["ai-gateway", "policy", "usage-governance"] },
  { env: "VERCEL_CONTEXT_BRIDGE", id: "vercel-context-bridge", label: "Vercel Context Bridge", class: "hosting", locality: "public", capabilities: ["http", "deployment"] },
  { env: "VERCEL_INFRA", id: "vercel-infra", label: "Vercel Infrastructure", class: "hosting", locality: "public", capabilities: ["http", "deployment"] },
  { env: "RAILWAY_API", id: "railway-api", label: "Railway API", class: "hosting", locality: "public", capabilities: ["http", "deployment"] },
  { env: "RAILWAY_ORCHESTRATOR", id: "railway-orchestrator", label: "Railway Orchestrator", class: "hosting", locality: "public", capabilities: ["http", "orchestration"] },
  { env: "RAILWAY_CLOUD", id: "railway-cloud", label: "Railway Cloud", class: "hosting", locality: "public", capabilities: ["http", "deployment"] },
  { env: "RAILWAY_ROADIE", id: "railway-roadie", label: "Railway Roadie", class: "ai", locality: "public", capabilities: ["http", "agent"] },
  { env: "RAILWAY_CORE", id: "railway-core", label: "Railway Core", class: "hosting", locality: "public", capabilities: ["http", "core-service"] },
  { env: "DO_CODEX_INFINITY", endpointEnv: "DO_CODEX_INFINITY_IPV4", id: "digitalocean-codex-infinity", label: "DigitalOcean Codex Infinity", class: "hosting", locality: "public", capabilities: ["compute", "ssh"] },
  { env: "DO_SHELLFISH", endpointEnv: "DO_SHELLFISH_IPV4", id: "digitalocean-shellfish", label: "DigitalOcean Shellfish", class: "hosting", locality: "public", capabilities: ["compute", "ssh"] },
  { env: "SUPABASE", endpointEnv: "SUPABASE_DB_HOST", id: "supabase", label: "Supabase", class: "data", locality: "provider", capabilities: ["database", "auth", "storage", "realtime"] },
  { env: "QUICKNODE", id: "quicknode", label: "QuickNode", class: "data", locality: "provider", capabilities: ["rpc", "blockchain"] },
  { env: "NEURA", id: "neura-relay", label: "Neura Relay", class: "governance", locality: "provider", capabilities: ["decision-gate", "receipt", "trace"] },
  { env: "GSC", id: "gsc-wizard", label: "GSC Wizard", class: "data", locality: "provider", capabilities: ["search-console", "seo"] },
  { env: "RESEND", id: "resend", label: "Resend", class: "communications", locality: "provider", capabilities: ["email", "webhooks", "events"] },
  { env: "NVIDIA", id: "nvidia", label: "NVIDIA", class: "ai", locality: "hybrid", capabilities: ["jetson", "cuda", "inference", "gpu"] },
  { env: "DATAVERSE", id: "dataverse", label: "Microsoft Dataverse", class: "data", locality: "hybrid", capabilities: ["crm", "odata", "metadata"] },
  { env: "1PASSWORD", id: "1password", label: "1Password", class: "identity", locality: "local", capabilities: ["secret-reference", "environment", "mcp"] },
  { env: "ZZZOPS", id: "zzzops", label: "ZzzOps", class: "developer", locality: "local", capabilities: ["goals", "execution", "verification"] },
  { env: "GODADDY", id: "godaddy", label: "GoDaddy", class: "domain", locality: "provider", capabilities: ["domains"] },
  { env: "SEARCH", id: "search", label: "Search", class: "data", locality: "provider", capabilities: ["web-search"] },
  { env: "SLACK", id: "slack", label: "Slack", class: "communications", locality: "provider", capabilities: ["messages", "channels", "files"] },
  { env: "AIRTABLE", id: "airtable", label: "Airtable", class: "data", locality: "provider", capabilities: ["records", "schema", "operations"] },
  { env: "NOTION", id: "notion", label: "Notion", class: "productivity", locality: "provider", capabilities: ["docs", "databases", "search"] },
  { env: "POSTHOG", id: "posthog", label: "PostHog", class: "observability", locality: "provider", capabilities: ["analytics", "logs", "llm-traces", "feature-flags"] },
  { env: "AMPLITUDE", id: "amplitude", label: "Amplitude", class: "observability", locality: "provider", capabilities: ["product-analytics"] },
  { env: "SEMRUSH", id: "semrush", label: "Semrush", class: "data", locality: "provider", capabilities: ["seo", "traffic", "keywords"] },
  { env: "WORKOS", id: "workos", label: "WorkOS", class: "identity", locality: "provider", capabilities: ["sso", "directory", "organizations"] },
  { env: "FIREFLIES", id: "fireflies", label: "Fireflies", class: "communications", locality: "provider", capabilities: ["meeting-transcripts"] },
  { env: "GITHUB", id: "github", label: "GitHub", class: "developer", locality: "provider", capabilities: ["repos", "issues", "pull-requests", "actions"] },
  { env: "LINEAR", id: "linear", label: "Linear", class: "developer", locality: "provider", capabilities: ["issues", "projects", "releases"] },
  { env: "HUGGINGFACE", id: "hugging-face", label: "Hugging Face", class: "ai", locality: "provider", capabilities: ["models", "datasets", "spaces", "jobs"] },
  { env: "OPENAI_PLATFORM", id: "openai-platform", label: "OpenAI Platform", class: "ai", locality: "provider", capabilities: ["models", "api-projects"] },
  { env: "STRIPE", id: "stripe", label: "Stripe", class: "data", locality: "provider", capabilities: ["payments"] },
  { env: "ZOOM", id: "zoom", label: "Zoom", class: "communications", locality: "provider", capabilities: ["meetings", "recordings"] },
  { env: "GMAIL", id: "gmail", label: "Gmail", class: "communications", locality: "provider", capabilities: ["email"] },
  { env: "GOOGLE_CALENDAR", id: "google-calendar", label: "Google Calendar", class: "productivity", locality: "provider", capabilities: ["calendar", "availability"] },
  { env: "GOOGLE_DRIVE", id: "google-drive", label: "Google Drive", class: "productivity", locality: "provider", capabilities: ["files", "docs", "sheets", "slides"] },
  { env: "MICROSOFT_SHAREPOINT", id: "microsoft-sharepoint", label: "Microsoft SharePoint / OneDrive", class: "productivity", locality: "provider", capabilities: ["files", "sharepoint", "onedrive"] },
  { env: "CALENDLY", id: "calendly", label: "Calendly", class: "productivity", locality: "provider", capabilities: ["scheduling", "availability"] },
  { env: "DOCUSIGN", id: "docusign", label: "DocuSign", class: "documents", locality: "provider", capabilities: ["esign", "agreements"] },
  { env: "ASANA", id: "asana", label: "Asana", class: "productivity", locality: "provider", capabilities: ["tasks", "projects"] },
  { env: "GITBOOK", id: "gitbook", label: "GitBook", class: "documents", locality: "provider", capabilities: ["docs", "sites"] },
  { env: "PROXYMAN", id: "proxyman", label: "Proxyman", class: "local-bridge", locality: "local", capabilities: ["http-observation", "proxy", "mcp"] },
  { env: "WEBFLOW", id: "webflow", label: "Webflow", class: "hosting", locality: "provider", capabilities: ["sites", "cms", "webhooks"] },
  { env: "BASE44", id: "base44", label: "Base44", class: "hosting", locality: "provider", capabilities: ["apps", "entities", "oauth-connectors"] },
  { env: "APPDEPLOY", id: "appdeploy", label: "AppDeploy", class: "hosting", locality: "provider", capabilities: ["apps", "deployments"] },
  { env: "JOTFORM", id: "jotform", label: "Jotform", class: "data", locality: "provider", capabilities: ["forms", "submissions"] },
  { env: "PANDADOC", id: "pandadoc", label: "PandaDoc", class: "documents", locality: "provider", capabilities: ["documents", "esign"] },
  { env: "ZOHO_CRM", id: "zoho-crm", label: "Zoho CRM", class: "data", locality: "provider", capabilities: ["crm", "sales-ops"] },
  { env: "RETELL", id: "retell-ai", label: "Retell AI", class: "communications", locality: "provider", capabilities: ["voice-agents"] },
  { env: "WINDSOR", id: "windsor-ai", label: "Windsor.ai", class: "data", locality: "provider", capabilities: ["data-connectors"] },
  { env: "MEETGEEK", id: "meetgeek", label: "MeetGeek", class: "communications", locality: "provider", capabilities: ["meeting-transcripts"] },
  { env: "GRANOLA", id: "granola", label: "Granola", class: "communications", locality: "provider", capabilities: ["meeting-notes"] },
];

function env(name: string): string | null {
  return Netlify.env.get(name) ?? null;
}

function normalizedStatus(status: string | null) {
  if (!status) return "UNKNOWN";
  const upper = status.toUpperCase();

  if (upper.includes("TIMEOUT")) return "TIMEOUT_UNKNOWN";
  if (upper.includes("AUTH_REQUIRED") || upper.includes("DECLINED")) return "AUTH_REQUIRED";
  if (upper.includes("AUTH_FAILED") || upper.includes("ACCOUNT_CONNECTION_FAILED")) return "AUTH_FAILED";
  if (upper.includes("FORBIDDEN")) return "FORBIDDEN";
  if (upper.includes("MISCONFIGURED")) return "MISCONFIGURED";
  if (upper.includes("NO_ACCOUNT") || upper.includes("ACCOUNT_NOT_PROVISIONED")) return "ACCOUNT_REQUIRED";
  if (upper.includes("CONFIGURED_NO_ACTIVE_DEPLOY") || upper === "INACTIVE") return "INACTIVE";
  if (upper.includes("REQUIRES_TAILNET_CONFIG")) return "CONFIG_REQUIRED";
  if (upper.includes("API_UNITS_REQUIRED")) return "LIMIT_REQUIRED";
  if (upper.includes("UNVERIFIED")) return "UNVERIFIED";
  if (upper.includes("NO_PROPERTIES_CONNECTED") || upper.includes("NO_DOMAINS_WEBHOOKS_EVENTS") || upper.includes("CONNECTED_NO_APPS") || upper.includes("CONNECTED_NO_ASSETS")) return "READY_EMPTY";
  if (upper.includes("INSTALLED_SKILL") || upper.includes("DIRECT_MCP_NOT_EXPOSED") || upper.includes("LOCAL_MCP") || upper.includes("LOCAL_APP_MCP") || upper.includes("CODEX_REPOSITORY_GOAL_LOOP")) return "LOCAL_BRIDGE";
  if (upper.includes("READY") || upper.includes("CONNECTED") || upper.includes("CALLABLE") || upper.includes("VALIDATED_GOVERNANCE_GATE") || upper.includes("PRIVATE_SERVICE_MESH") || upper.includes("BUILTIN_WEB_SEARCH_AVAILABLE")) return "READY";
  return upper;
}

function materialize(spec: ServiceSpec) {
  const rawStatus = env(`ROAD_GATEWAY_${spec.statusEnv ?? spec.env}_STATUS`);
  return {
    id: spec.id,
    label: spec.label,
    roadUri: spec.roadUri ?? `road://connector/${spec.id}`,
    tailscaleService: spec.tailscaleService ?? null,
    class: spec.class,
    locality: spec.locality,
    capabilities: spec.capabilities,
    status: normalizedStatus(rawStatus),
    providerStatus: rawStatus,
    endpoint: env(`ROAD_GATEWAY_${spec.endpointEnv ?? spec.env}`),
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,HEAD,OPTIONS" } });
  if (!new Set(["GET", "HEAD"]).has(req.method)) return json({ error: "method_not_allowed" }, 405);

  const all = services.map(materialize);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/gateway";
  const counts = all.reduce<Record<string, number>>((acc, svc) => {
    acc[svc.status] = (acc[svc.status] ?? 0) + 1;
    return acc;
  }, {});

  let body: unknown;
  if (path === "/gateway") {
    body = {
      schema: env("ROAD_GATEWAY_SCHEMA_VERSION") ?? "1",
      name: "BlackRoad Gateway",
      roadUri: "road://gateway",
      policy: env("ROAD_GATEWAY_POLICY"),
      generatedAt: new Date().toISOString(),
      counts,
      routes: ["/gateway/services", "/gateway/health", "/gateway/capabilities", "/gateway/services/:id"],
    };
  } else if (path === "/gateway/services") {
    body = { generatedAt: new Date().toISOString(), services: all };
  } else if (path === "/gateway/health") {
    body = { generatedAt: new Date().toISOString(), total: all.length, counts, unhealthy: all.filter((s) => s.status !== "READY" && s.status !== "LOCAL_BRIDGE") };
  } else if (path === "/gateway/capabilities") {
    const capabilities = [...new Set(all.flatMap((s) => s.capabilities))].sort().map((capability) => ({
      capability,
      services: all.filter((s) => s.capabilities.includes(capability)).map((s) => s.id),
    }));
    body = { generatedAt: new Date().toISOString(), capabilities };
  } else if (path.startsWith("/gateway/services/")) {
    const id = decodeURIComponent(path.slice("/gateway/services/".length));
    const service = all.find((s) => s.id === id);
    if (!service) return json({ error: "service_not_found", id }, 404);
    body = service;
  } else {
    return json({ error: "not_found", path }, 404);
  }

  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
  return json(body);
};

export const config: Config = {
  path: ["/gateway", "/gateway/*"],
  method: ["GET", "HEAD", "OPTIONS"],
};
