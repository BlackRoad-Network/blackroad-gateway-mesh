import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_RE = /^agent-instance-[1-6]$/;
const SECRET_FIELD_RE = /(secret|password|token|private[_-]?key|api[_-]?key|credential|cookie|authorization)/i;

const PUBLIC_EXPOSURE = new Set(["public.expose", "funnel.enable", "dns.publish", "deploy.production", "site.publish"]);
const ADMIN_ACTIONS = new Set(["admin", "network.modify", "identity.modify", "billing.modify", "schema.modify", "permission.modify"]);
const IMPORTANT_ACTIONS = new Set(["deploy", "send", "publish", "external.write", "merge", "release"]);
const READ_ACTIONS = new Set(["discover", "metadata.read", "health", "capabilities", "read", "list", "get", "search", "inspect"]);

const CONNECTOR_OWNER = new Map([
  ["tailscale", "agent-instance-1"],
  ["nvidia", "agent-instance-1"],
  ["proxyman", "agent-instance-1"],
  ["github", "agent-instance-4"],
  ["forgejo", "agent-instance-4"],
  ["linear", "agent-instance-4"],
  ["asana", "agent-instance-4"],
  ["airtable", "agent-instance-4"],
  ["notion", "agent-instance-4"],
  ["gitbook", "agent-instance-4"],
  ["google-drive", "agent-instance-4"],
  ["sharepoint", "agent-instance-4"],
  ["slack", "agent-instance-4"],
  ["gmail", "agent-instance-4"],
  ["google-calendar", "agent-instance-4"],
  ["resend", "agent-instance-4"],
  ["netlify", "agent-instance-4"],
  ["vercel", "agent-instance-4"],
  ["railway", "agent-instance-4"],
  ["1password", "agent-instance-4"],
  ["neura-relay", "agent-instance-4"],
  ["posthog", "agent-instance-4"],
  ["stripe", "agent-instance-4"],
  ["dataverse", "agent-instance-4"],
  ["supabase", "agent-instance-4"]
]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function collection(value, candidates) {
  for (const key of candidates) {
    if (Array.isArray(value?.[key])) return value[key];
    if (value?.[key] && typeof value[key] === "object") {
      return Object.entries(value[key]).map(([id, entry]) => ({ id, ...entry }));
    }
  }
  return [];
}

function actionFamily(operation = "read", mode = "read") {
  const normalized = String(operation).toLowerCase().replaceAll("_", ".");
  if (mode === "read" || READ_ACTIONS.has(normalized) || normalized.endsWith(".read") || normalized.startsWith("get") || normalized.startsWith("list")) return "metadata";
  if (PUBLIC_EXPOSURE.has(normalized) || normalized.includes("funnel") || normalized.includes("public") || normalized.includes("dns.publish")) return "public-exposure";
  if (ADMIN_ACTIONS.has(normalized) || normalized.includes("admin") || normalized.includes("permission") || normalized.includes("billing") || normalized.includes("identity.modify")) return "admin";
  if (IMPORTANT_ACTIONS.has(normalized) || normalized.includes("deploy") || normalized.includes("publish") || normalized.includes("send") || normalized.includes("merge") || normalized.includes("release")) return "important-write";
  if (normalized.includes("secret") || normalized.includes("credential") || normalized.includes("token.rotate")) return "secret";
  return "ordinary-write";
}

function inferDomainOwner(input) {
  const text = `${input.operation ?? ""} ${input.target ?? ""} ${input.connector ?? ""}`.toLowerCase();
  if (/(device|ssh|radio|serial|neighbor|tailscale|network)/.test(text)) return "agent-instance-1";
  if (/(canon|program-os|schema|command|service-model|lifecycle)/.test(text)) return "agent-instance-2";
  if (/(domain|dns|hostname|road-uri|path|route|port)/.test(text)) return "agent-instance-3";
  if (/(skill|procedure|prompt|eval)/.test(text)) return "agent-instance-5";
  if (/(kernel|ipc|daemon|socket|driver|runtime|systemd|launchd)/.test(text)) return "agent-instance-6";
  return CONNECTOR_OWNER.get(input.connector) ?? "agent-instance-4";
}

function rejectInlineSecrets(value, path = "input") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (SECRET_FIELD_RE.test(key) && item != null && !/ref$/i.test(key)) {
      throw Object.assign(new Error(`secret_value_forbidden:${here}`), { code: "SECRET_VALUE_FORBIDDEN" });
    }
    if (typeof item === "object") rejectInlineSecrets(item, here);
  }
}

function findById(items, id) {
  return items.find((item) => item?.id === id || item?.connectorId === id || item?.pluginId === id || item?.name === id) ?? null;
}

function tierDefinition(permissionPolicy, tier) {
  return collection(permissionPolicy, ["tiers"]).find((entry) => entry.id === tier) ?? null;
}

function connectorOverride(permissionPolicy, connector) {
  return collection(permissionPolicy, ["pluginOverrides", "connectorOverrides", "overrides"])
    .find((entry) => entry.pluginId === connector || entry.connectorId === connector || entry.id === connector) ?? null;
}

function profileFor(profiles, agentId) {
  return collection(profiles, ["profiles", "agents"]).find((entry) => entry.id === agentId) ?? null;
}

function policyFor(policy, connector) {
  return findById(collection(policy, ["connectors", "policies", "rules", "entries"]), connector);
}

function topologyFor(topology, connector) {
  return findById(collection(topology, ["connectors", "nodes", "services"]), connector);
}

function resourceKey(connectorPolicy, input) {
  const raw = connectorPolicy?.resourceKey ?? connectorPolicy?.resource_key ?? connectorPolicy?.keyTemplate;
  if (typeof raw === "string") {
    return raw
      .replaceAll("{connector}", input.connector)
      .replaceAll("{target}", input.target)
      .replaceAll("${connector}", input.connector)
      .replaceAll("${target}", input.target);
  }
  return `${input.connector}::${input.target}`;
}

export async function loadDispatchContext(overrides = {}) {
  const [profiles, connectorPolicy, connectorTopology, permissionPolicy] = await Promise.all([
    overrides.profiles ?? loadJson(resolve(HERE, "../skills/agent-profiles.json"), { profiles: [] }),
    overrides.connectorPolicy ?? loadJson(resolve(HERE, "connector-policy.json"), { connectors: [] }),
    overrides.connectorTopology ?? loadJson(resolve(HERE, "connector-topology.json"), { connectors: [] }),
    overrides.permissionPolicy ?? loadJson(resolve(HERE, "../plugins/permission-policy.json"), { tiers: [], pluginOverrides: [] })
  ]);
  return { profiles, connectorPolicy, connectorTopology, permissionPolicy };
}

export async function planDispatch(input, overrides = {}) {
  rejectInlineSecrets(input);
  const agentId = input.agentId;
  if (!AGENT_RE.test(agentId ?? "")) throw Object.assign(new Error("invalid_agent_id"), { code: "INVALID_AGENT_ID" });
  if (!input.connector || !input.target || !input.operation) throw Object.assign(new Error("connector_target_operation_required"), { code: "INVALID_REQUEST" });

  const context = await loadDispatchContext(overrides);
  const profile = profileFor(context.profiles, agentId);
  const connectorPolicy = policyFor(context.connectorPolicy, input.connector);
  const topology = topologyFor(context.connectorTopology, input.connector);
  const family = actionFamily(input.operation, input.mode ?? "read");
  const override = connectorOverride(context.permissionPolicy, input.connector);
  const tier = override?.tier ?? family;
  const tierRule = tierDefinition(context.permissionPolicy, tier);
  const mutating = family !== "metadata";
  const publicExposure = family === "public-exposure";
  const admin = family === "admin";
  const secret = family === "secret";
  const claimRequired = mutating;
  const expectedVersionRequired = Boolean(
    mutating && (
      connectorPolicy?.expectedVersionRequired ??
      connectorPolicy?.expected_version_required ??
      connectorPolicy?.versionFence ??
      ["github", "forgejo", "airtable", "notion", "netlify", "vercel", "dataverse", "supabase"].includes(input.connector)
    )
  );
  const neuraRequired = Boolean(mutating && (publicExposure || admin || family === "important-write" || connectorPolicy?.neuraRequired));
  const idempotencyRequired = mutating;
  const domainOwner = inferDomainOwner(input);
  const connectorOwner = CONNECTOR_OWNER.get(input.connector) ?? "agent-instance-4";
  const handoffRequired = mutating && agentId !== domainOwner && !input.delegationRef;
  const blockedBy = [];

  if (!profile) blockedBy.push("agent_profile_missing");
  if (idempotencyRequired && !input.idempotencyKey) blockedBy.push("idempotency_key_required");
  if (expectedVersionRequired && !input.expectedVersion) blockedBy.push("expected_provider_version_required");
  if (neuraRequired && !input.decisionReceiptRef) blockedBy.push("neura_decision_receipt_required");
  if (secret && !input.secretRef) blockedBy.push("secret_reference_required");
  if (handoffRequired) blockedBy.push(`handoff_or_delegation_required:${domainOwner}`);

  const requiredGates = new Set([
    ...(profile?.requiredGates ?? []),
    ...(connectorPolicy?.writeGates ?? connectorPolicy?.requiredGates ?? []),
    ...(tierRule?.gate ? String(tierRule.gate).split("+") : [])
  ]);
  if (claimRequired) requiredGates.add("exclusive_connector_claim");
  if (idempotencyRequired) requiredGates.add("idempotency_key");
  if (expectedVersionRequired) requiredGates.add("expected_provider_version");
  if (neuraRequired) requiredGates.add("neura_decision_receipt");
  if (secret) requiredGates.add("reference_only_secret");

  const plan = {
    schema: "road-connector-dispatch-plan-v1",
    planId: `dispatch_${randomUUID()}`,
    planHash: null,
    createdAt: new Date().toISOString(),
    agentId,
    sessionId: input.sessionId ?? null,
    connector: input.connector,
    connectorOwner,
    domainOwner,
    target: input.target,
    resourceKey: resourceKey(connectorPolicy, input),
    operation: input.operation,
    mode: input.mode ?? (mutating ? "write" : "read"),
    actionFamily: family,
    permissionTier: tier,
    mutating,
    claimRequired,
    idempotencyRequired,
    expectedVersionRequired,
    neuraRequired,
    providerNativeAuthRequired: Boolean(mutating || (connectorPolicy?.providerNativeAuthRequired ?? false)),
    handoffRequired,
    delegationRef: input.delegationRef ?? null,
    requiredGates: [...requiredGates].filter(Boolean).sort(),
    blockedBy,
    canDispatch: blockedBy.length === 0,
    expectedVersion: input.expectedVersion ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    decisionReceiptRef: input.decisionReceiptRef ?? null,
    secretRef: input.secretRef ?? null,
    payloadRef: input.payloadRef ?? null,
    connectorPolicyRef: connectorPolicy?.id ?? input.connector,
    topologyPlane: topology?.plane ?? topology?.kind ?? topology?.authorityPlane ?? "connector",
    resultSemantics: {
      timeout: "TIMEOUT_UNKNOWN",
      successfulZeroResult: "EMPTY_OBSERVATION",
      authenticationRejected: "AUTH_REJECTED_NOT_ABSENT",
      connectorSuccess: "STEP_SUCCEEDED_NOT_WORKFLOW_COMPLETE"
    }
  };
  plan.planHash = hash({ ...plan, planId: null, planHash: null, createdAt: null });
  return plan;
}

export function redactPublic(value) {
  if (Array.isArray(value)) return value.map(redactPublic);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key) && !/ref$/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = redactPublic(item);
  }
  return output;
}

export const dispatchInternals = {
  actionFamily,
  inferDomainOwner,
  rejectInlineSecrets,
  stableStringify,
  hash
};
