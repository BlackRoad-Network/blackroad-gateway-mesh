import { access, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "dispatch.mjs",
  "workflow.mjs",
  "reconcile.mjs",
  "client.mjs",
  "daemon.mjs",
  "mcp-server.mjs",
  "schemas/dispatch-plan.schema.json",
  "schemas/workflow-plan.schema.json",
  "schemas/connector-result.schema.json",
  "tests/runtime.test.mjs"
];

for (const file of required) await access(resolve(root, file));
for (const file of required.filter((file) => file.endsWith(".json"))) {
  JSON.parse(await readFile(resolve(root, file), "utf8"));
}

const source = await Promise.all(
  required
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => readFile(resolve(root, file), "utf8"))
);
const forbidden = [
  /-----BEGIN (?:OPENSSH|RSA|EC|PRIVATE)/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/
];
for (const pattern of forbidden) {
  if (source.some((text) => pattern.test(text))) {
    throw new Error(`secret_pattern_detected:${pattern}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  checkedFiles: required.length,
  secretPatterns: forbidden.length
}));
