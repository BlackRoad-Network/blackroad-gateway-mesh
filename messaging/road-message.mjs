#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  platforms,
  operations,
  platformCapability,
  validateOperationEnvelope,
  normalizeInboundEvent,
  planCollaborationSequence,
} from "./runtime.mjs";

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const command = process.argv[2] ?? "status";

if (command === "status") {
  output({
    service: "road://service/conversations",
    platforms: platforms.size,
    operations: operations.size,
    publicExecution: false,
  });
} else if (command === "platforms") {
  output([...platforms.values()]);
} else if (command === "operations") {
  output([...operations.values()]);
} else if (command === "capability") {
  output(platformCapability(process.argv[3], process.argv[4]));
} else if (command === "normalize-event") {
  output(normalizeInboundEvent(JSON.parse(readFileSync(0, "utf8"))));
} else if (command === "plan") {
  const envelope = {
    operation: option("--operation"),
    platform: option("--platform"),
    resourceKey: option("--resource"),
    agentId: option("--agent"),
    sessionRef: option("--session"),
    intentId: option("--intent"),
    claimId: option("--claim"),
    invocationId: option("--invocation"),
    idempotencyKey: option("--idempotency"),
    requestHash: option("--request-hash"),
    targetOwnerAgent: option("--owner"),
    contentRef: option("--content-ref"),
    contentHash: option("--content-hash"),
    userApprovalRef: option("--approval"),
    decisionReceiptRef: option("--decision"),
  };
  validateOperationEnvelope(envelope);
  output(planCollaborationSequence(envelope));
} else {
  process.stderr.write(`unknown command: ${command}\n`);
  process.exit(2);
}
