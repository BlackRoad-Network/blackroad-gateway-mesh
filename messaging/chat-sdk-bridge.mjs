import { createRequire } from "node:module";
import { MessagingError, assertSafeValue, normalizeProvider } from "./core.mjs";

const require = createRequire(import.meta.url);

export const CHAT_SDK_ADAPTERS = Object.freeze({
  slack: { package: "@chat-adapter/slack", factory: "createSlackAdapter" },
  "microsoft-teams": { package: "@chat-adapter/teams", factory: "createTeamsAdapter" },
  "google-chat": { package: "@chat-adapter/gchat", factory: "createGoogleChatAdapter" },
  discord: { package: "@chat-adapter/discord", factory: "createDiscordAdapter" },
  github: { package: "@chat-adapter/github", factory: "createGitHubAdapter" },
  linear: { package: "@chat-adapter/linear", factory: "createLinearAdapter" },
  telegram: { package: "@chat-adapter/telegram", factory: "createTelegramAdapter" },
  whatsapp: { package: "@chat-adapter/whatsapp", factory: "createWhatsAppAdapter" },
});

function packageAvailable(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

export function inspectChatSdkPackages(providers = Object.keys(CHAT_SDK_ADAPTERS)) {
  return {
    chat: packageAvailable("chat"),
    stateMemory: packageAvailable("@chat-adapter/state-memory"),
    providers: Object.fromEntries(
      providers.map((providerInput) => {
        const provider = normalizeProvider(providerInput);
        const spec = CHAT_SDK_ADAPTERS[provider];
        return [provider, spec ? {
          package: spec.package,
          factory: spec.factory,
          available: packageAvailable(spec.package),
        } : {
          package: null,
          factory: null,
          available: false,
          unsupported: true,
        }];
      }),
    ),
  };
}

export async function createChatSdkRuntime(config = {}) {
  const providers = [...new Set(config.providers ?? [])].map(normalizeProvider);
  if (providers.length === 0) {
    throw new MessagingError("CHAT_PROVIDER_REQUIRED", "At least one Chat SDK provider is required");
  }
  assertSafeValue(config.publicOptions ?? {}, "chatSdk.publicOptions");

  const inspection = inspectChatSdkPackages(providers);
  const missing = [];
  if (!inspection.chat) missing.push("chat");
  if (!inspection.stateMemory && !config.state) missing.push("@chat-adapter/state-memory or injected state");
  for (const [provider, status] of Object.entries(inspection.providers)) {
    if (!status.available) missing.push(status.package ?? provider);
  }
  if (missing.length) {
    throw new MessagingError("CHAT_SDK_PACKAGE_MISSING", "Chat SDK runtime packages are not installed", { missing });
  }

  const { Chat } = await import("chat");
  let state = config.state;
  if (!state) {
    const stateModule = await import("@chat-adapter/state-memory");
    state = stateModule.createMemoryState();
  }

  const adapters = {};
  for (const provider of providers) {
    const spec = CHAT_SDK_ADAPTERS[provider];
    if (!spec) throw new MessagingError("CHAT_PROVIDER_UNSUPPORTED", `No Chat SDK adapter mapping for ${provider}`);
    const module = await import(spec.package);
    const factory = module[spec.factory];
    if (typeof factory !== "function") {
      throw new MessagingError("CHAT_ADAPTER_FACTORY_MISSING", `${spec.package} does not export ${spec.factory}`);
    }
    // Provider credentials stay inside adapter construction and are never returned or persisted.
    adapters[provider] = factory(config.adapterOptions?.[provider] ?? {});
  }

  const chat = new Chat({
    userName: config.userName ?? "roadie",
    adapters,
    state,
    dedupeTtlMs: config.dedupeTtlMs ?? 600_000,
    streamingUpdateIntervalMs: config.streamingUpdateIntervalMs ?? 500,
    fallbackStreamingPlaceholderText: config.fallbackStreamingPlaceholderText ?? "...",
  });

  wireInboundEvents(chat, config.eventSink);
  return { chat, providers, inspection };
}

function wireInboundEvents(chat, eventSink) {
  if (typeof eventSink !== "function") return;

  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await eventSink(normalizeChatSdkEvent("MENTION", thread, message));
  });

  chat.onDirectMessage(async (thread, message) => {
    await thread.subscribe();
    await eventSink(normalizeChatSdkEvent("DIRECT_MESSAGE", thread, message));
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await eventSink(normalizeChatSdkEvent("MESSAGE", thread, message));
  });

  chat.onReaction(async (event) => {
    await eventSink({
      schema: "road-chat-sdk-inbound-v1",
      kind: "REACTION",
      provider: event?.adapterName ?? event?.platform ?? null,
      providerEventRef: event?.id ?? null,
      rawRefOnly: true,
    });
  });
}

function normalizeChatSdkEvent(kind, thread, message) {
  return {
    schema: "road-chat-sdk-inbound-v1",
    kind,
    provider: message?.adapterName ?? message?.platform ?? thread?.adapterName ?? null,
    providerThreadRef: thread?.id ?? thread?.key ?? null,
    providerMessageRef: message?.id ?? null,
    authorRef: message?.author?.id ?? message?.authorId ?? null,
    text: message?.text ?? null,
    formatted: Boolean(message?.formatted),
    attachmentCount: Array.isArray(message?.attachments) ? message.attachments.length : 0,
    rawRefOnly: true,
  };
}
