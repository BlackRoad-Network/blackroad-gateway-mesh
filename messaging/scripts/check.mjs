import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const errors = [];

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: ${error.message}`);
    return null;
  }
}

const registry = await json(join(root, "provider-capabilities.json"));
const policy = await json(join(root, "provider-policy.json"));
const packageJson = await json(join(root, "package.json"));
const schemaDir = join(root, "schemas");
const schemaFiles = (await readdir(schemaDir)).filter((name) => name.endsWith(".json"));
for (const file of schemaFiles) await json(join(schemaDir, file));

if (registry?.schema !== "road-messaging-provider-capabilities-v1") errors.push("provider registry schema mismatch");
if (policy?.schema !== "road-messaging-provider-policy-v1") errors.push("provider policy schema mismatch");
if (packageJson?.type !== "module") errors.push("package must use ESM");
if (Object.keys(packageJson?.dependencies ?? {}).length) errors.push("messaging core must remain dependency-free");

const providers = registry?.providers ?? {};
const requiredProviders = ["slack", "github", "linear", "asana", "notion", "airtable", "microsoft-teams"];
for (const provider of requiredProviders) {
  if (!providers[provider]) errors.push(`missing provider capability entry: ${provider}`);
}
for (const [provider, definition] of Object.entries(providers)) {
  const caps = definition.capabilities ?? {};
  for (const key of [
    "discoverConversations", "readMessages", "readThreads", "createConversation",
    "postTopLevel", "reply", "editOwn", "deleteOwn", "react", "resolve",
    "inlineComment", "attachments", "richCards", "streaming", "search",
  ]) {
    if (!(key in caps)) errors.push(`${provider} missing capability ${key}`);
  }
  for (const [name, value] of Object.entries(caps)) {
    if (![true, false, "UNVERIFIED", "PARTIAL"].includes(value)) {
      errors.push(`${provider}.${name} has invalid capability state ${JSON.stringify(value)}`);
    }
  }
  if (!definition.transport) errors.push(`${provider} missing transport`);
  if (!definition.surfaceState) errors.push(`${provider} missing surfaceState`);
}

if (providers["microsoft-teams"]?.chatSdk?.package !== "@chat-adapter/teams") {
  errors.push("Microsoft Teams must map to the official Chat SDK adapter package");
}
if (providers.slack?.nativeTools?.post !== "slack_send_message") errors.push("Slack post mapping missing");
if (providers.github?.nativeTools?.post !== "add_comment_to_issue") errors.push("GitHub comment mapping missing");
if (providers.notion?.nativeTools?.postOrReply !== "notion-create-comment") errors.push("Notion comment mapping missing");
if (providers.airtable?.nativeTools?.postOrReply !== "create_record_comment") errors.push("Airtable comment mapping missing");
if (providers.asana?.capabilities?.reply !== false) errors.push("Asana current reply capability must remain false");
if (policy?.defaults?.bidirectionalMirror !== false) errors.push("bidirectional mirroring must be disabled by default");
if (policy?.defaults?.secretTransit !== "PROHIBITED") errors.push("secret transit must be prohibited");

const sourceFiles = [
  "core.mjs", "provider-plan.mjs", "store.mjs", "chat-sdk-bridge.mjs", "cli.mjs", "mcp-server.mjs",
].map((name) => join(root, name));
for (const file of sourceFiles) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    errors.push(`${file}: Node syntax check failed: ${error.stderr?.toString() || error.message}`);
  }
}

const mcpSource = await readFile(join(root, "mcp-server.mjs"), "utf8");
const tools = [...mcpSource.matchAll(/name:\s*"messaging_[a-z0-9_]+"/g)].map((match) => match[0]);
if (tools.length < 10) errors.push(`expected at least 10 MCP tools, found ${tools.length}`);

const allText = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:mjs|json|md|yml|yaml|sh)$/.test(entry.name)) {
      allText.push([path, await readFile(path, "utf8")]);
    }
  }
}
await collect(root);
for (const [path, text] of allText) {
  if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(text)) {
    errors.push(`${path}: private key material detected`);
  }
  if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) {
    errors.push(`${path}: GitHub token-shaped value detected`);
  }
}

const result = {
  ok: errors.length === 0,
  protocol: "road-messaging/1.0",
  providers: Object.keys(providers).length,
  connectedToolProviders: Object.values(providers).filter((entry) => entry.transport === "connected-tool").length,
  chatSdkProviders: Object.values(providers).filter((entry) => entry.transport === "vercel-chat-sdk").length,
  schemas: schemaFiles.length,
  mcpTools: tools.length,
  errors,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
