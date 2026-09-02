#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  bindThread,
  buildProviderOperation,
  createThread,
  doctorState,
  planMessage,
  planReaction,
  publicSnapshot,
  recordInboundMessage,
  recordProviderOutcome,
  resolveThread,
  verifyProjection,
} from "./core.mjs";
import { buildNativeMessagePlan } from "./provider-plan.mjs";
import { createMessagingStore } from "./store.mjs";
import { inspectChatSdkPackages } from "./chat-sdk-bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await readFile(resolve(here, "provider-capabilities.json"), "utf8"));
const store = createMessagingStore();
const [command = "help", ...argv] = process.argv.slice(2);

function parseArgs(args) {
  const output = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) {
      output._.push(item);
      continue;
    }
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) output[key] = true;
    else {
      output[key] = next;
      index += 1;
    }
  }
  return output;
}

function required(args, name) {
  if (args[name] === undefined || args[name] === null || args[name] === "") {
    throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return args[name];
}

function integer(args, name) {
  const value = Number(required(args, name));
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}

function jsonValue(value, fallback = {}) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const args = parseArgs(argv);

try {
  if (command === "help") {
    process.stdout.write(`road-message commands:
  init
  status
  doctor
  capabilities [--provider slack]
  chat-sdk-inspect [--providers slack,microsoft-teams]
  thread-create --owner-agent AGENT --title TITLE --resource-key KEY --idempotency KEY [--visibility INTERNAL]
  thread-bind --thread ID --version N --actor-agent AGENT --session REF --provider PROVIDER --provider-thread-ref REF --mode MODE --locator JSON
  message-plan --thread ID --version N --actor-agent AGENT --session REF --body TEXT --idempotency KEY [--approval REF] [--parent ID] [--binding-ids CSV]
  provider-plan --projection ID
  provider-outcome --projection ID --actor-agent AGENT --session REF --outcome OUTCOME [--provider-message-ref REF] [--evidence CSV]
  verify --projection ID --actor-agent AGENT --session REF --result RESULT --evidence CSV
  inbound --provider PROVIDER --event REF --thread-ref REF --message-ref REF --author REF --body TEXT
  reaction-plan --message ID --binding ID --version N --actor-agent AGENT --session REF --emoji NAME --idempotency KEY --approval REF
  resolve --thread ID --version N --actor-agent AGENT --session REF --resolution REF --approval REF
`);
  } else if (command === "init") {
    print(await store.initialize());
  } else if (command === "status") {
    const state = await store.load();
    print(publicSnapshot(state, registry));
  } else if (command === "doctor") {
    const state = await store.load();
    const doctor = doctorState(state);
    print(doctor);
    if (!doctor.ok) process.exitCode = 1;
  } else if (command === "capabilities") {
    if (args.provider) {
      const provider = String(args.provider).toLowerCase();
      print(registry.providers[provider] ?? null);
    } else {
      print(registry);
    }
  } else if (command === "chat-sdk-inspect") {
    const providers = String(args.providers ?? Object.keys(registry.providers).join(","))
      .split(",").map((value) => value.trim()).filter(Boolean);
    print(inspectChatSdkPackages(providers));
  } else if (command === "thread-create") {
    const result = await store.transact((state) => createThread(state, {
      ownerAgentId: required(args, "ownerAgent"),
      title: required(args, "title"),
      resourceKey: required(args, "resourceKey"),
      visibility: args.visibility ?? "INTERNAL",
      idempotencyKey: required(args, "idempotency"),
      participantRefs: String(args.participants ?? "").split(",").filter(Boolean),
    }));
    print({ thread: result.thread, replay: result.replay });
  } else if (command === "thread-bind") {
    const result = await store.transact((state) => bindThread(state, {
      threadId: required(args, "thread"),
      expectedThreadVersion: integer(args, "version"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      provider: required(args, "provider"),
      connectorId: args.connector,
      providerThreadRef: required(args, "providerThreadRef"),
      providerLocator: jsonValue(args.locator),
      surfaceKind: args.surfaceKind,
      mode: required(args, "mode"),
      visibility: args.visibility ?? "EXTERNAL",
      providerVersionRef: args.providerVersionRef,
      idempotencyKey: args.idempotency,
    }, registry));
    print({ binding: result.binding, thread: result.thread, replay: result.replay });
  } else if (command === "message-plan") {
    const result = await store.transact((state) => planMessage(state, {
      threadId: required(args, "thread"),
      expectedThreadVersion: integer(args, "version"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      body: required(args, "body"),
      idempotencyKey: required(args, "idempotency"),
      userApprovalRef: args.approval,
      parentMessageId: args.parent,
      kind: args.kind,
      targetBindingIds: String(args.bindingIds ?? "").split(",").filter(Boolean),
    }, registry));
    print({ message: result.message, projections: result.projections, thread: result.thread, replay: result.replay });
  } else if (command === "provider-plan") {
    const state = await store.load();
    const projection = state.projections.find((item) => item.id === required(args, "projection"));
    if (!projection) throw new Error("Projection not found");
    const binding = state.bindings.find((item) => item.id === projection.bindingId);
    const message = state.messages.find((item) => item.id === projection.messageId);
    const thread = state.threads.find((item) => item.id === projection.threadId);
    print(buildNativeMessagePlan({ projection, binding, message, thread, registry }));
  } else if (command === "provider-outcome") {
    const result = await store.transact((state) => recordProviderOutcome(state, {
      projectionId: required(args, "projection"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      outcome: required(args, "outcome"),
      providerRequestRef: args.providerRequestRef,
      providerMessageRef: args.providerMessageRef,
      errorClass: args.errorClass,
      evidenceRefs: String(args.evidence ?? "").split(",").filter(Boolean),
    }));
    print({ projection: result.projection, message: result.message });
  } else if (command === "verify") {
    const result = await store.transact((state) => verifyProjection(state, {
      projectionId: required(args, "projection"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      result: required(args, "result"),
      providerMessageRef: args.providerMessageRef,
      providerVersionRef: args.providerVersionRef,
      evidenceRefs: String(required(args, "evidence")).split(",").filter(Boolean),
    }));
    print({ projection: result.projection, message: result.message });
  } else if (command === "inbound") {
    const result = await store.transact((state) => recordInboundMessage(state, {
      provider: required(args, "provider"),
      providerEventId: required(args, "event"),
      providerThreadRef: required(args, "threadRef"),
      providerMessageRef: required(args, "messageRef"),
      authorRef: required(args, "author"),
      body: required(args, "body"),
      originRoadMessageId: args.originRoadMessageId,
      parentRoadMessageId: args.parentRoadMessageId,
    }));
    print({ providerEvent: result.providerEvent, message: result.message, replay: result.replay, echo: result.echo });
  } else if (command === "reaction-plan") {
    const result = await store.transact((state) => planReaction(state, {
      messageId: required(args, "message"),
      bindingId: required(args, "binding"),
      expectedThreadVersion: integer(args, "version"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      emoji: required(args, "emoji"),
      idempotencyKey: required(args, "idempotency"),
      userApprovalRef: args.approval,
    }, registry));
    print({ reaction: result.reaction, thread: result.thread, replay: result.replay });
  } else if (command === "resolve") {
    const result = await store.transact((state) => resolveThread(state, {
      threadId: required(args, "thread"),
      expectedThreadVersion: integer(args, "version"),
      actorAgentId: required(args, "actorAgent"),
      sessionRef: required(args, "session"),
      resolutionRef: required(args, "resolution"),
      userApprovalRef: args.approval,
      idempotencyKey: args.idempotency,
    }, registry));
    print({ thread: result.thread, projections: result.projections });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: error.code ?? "COMMAND_FAILED",
    message: error.message,
    details: error.details ?? null,
  }, null, 2)}\n`);
  process.exitCode = 1;
}
