import { MessagingError, assertSafeValue, normalizeProvider } from "./core.mjs";

function requireLocator(locator, names, provider) {
  const missing = names.filter((name) => locator?.[name] === undefined || locator?.[name] === null || locator?.[name] === "");
  if (missing.length) {
    throw new MessagingError(
      "PROVIDER_LOCATOR_INCOMPLETE",
      `${provider} provider locator is missing: ${missing.join(", ")}`,
      { provider, missing },
    );
  }
}

export function buildNativeMessagePlan({ projection, binding, message, thread, registry }) {
  if (!projection || !binding || !message || !thread) {
    throw new MessagingError("PLAN_INPUT_REQUIRED", "projection, binding, message, and thread are required");
  }
  const provider = normalizeProvider(binding.provider);
  const definition = registry?.providers?.[provider];
  if (!definition) throw new MessagingError("PROVIDER_NOT_REGISTERED", `No provider definition for ${provider}`);
  const locator = binding.providerLocator ?? {};
  assertSafeValue(locator, "providerLocator");

  const common = {
    provider,
    connectorId: binding.connectorId ?? provider,
    action: projection.action,
    resourceKey: binding.canonicalKey,
    projectionId: projection.id,
    requestHash: projection.requestHash,
    idempotencyKey: projection.idempotencyKey,
    requiresActionClass: projection.action === "RESOLVE" ? "WRITE" : "COMMUNICATE",
    requiresUserApproval: binding.visibility !== "INTERNAL",
    requiresReadAfterWriteVerification: true,
  };

  if (provider === "slack") {
    requireLocator(locator, ["channelId"], provider);
    const args = { channel_id: locator.channelId, message: message.body };
    if (projection.action === "REPLY") {
      requireLocator(locator, ["threadTs"], provider);
      args.thread_ts = locator.threadTs;
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "slack_send_message",
      arguments: args,
      verifyWith: {
        tool: "slack_read_thread",
        arguments: {
          channel_id: locator.channelId,
          message_ts: locator.threadTs ?? "$provider_message_ts",
          limit: 100,
          response_format: "detailed",
        },
        evidence: ["message timestamp", "body hash", "author identity"],
      },
    };
  }

  if (provider === "github") {
    requireLocator(locator, ["repoFullName", "pullRequestNumber"], provider);
    if (projection.action === "REPLY" && locator.reviewCommentId) {
      return {
        ...common,
        transport: "connected-tool",
        tool: "reply_to_review_comment",
        arguments: {
          repo_full_name: locator.repoFullName,
          pr_number: locator.pullRequestNumber,
          comment_id: locator.reviewCommentId,
          comment: message.body,
        },
        verifyWith: {
          tool: "fetch_pr_comments",
          arguments: {
            repo_full_name: locator.repoFullName,
            pr_number: locator.pullRequestNumber,
          },
          evidence: ["comment ID", "body hash", "pull request head"],
        },
      };
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "add_comment_to_issue",
      arguments: {
        repo_full_name: locator.repoFullName,
        pr_number: locator.pullRequestNumber,
        comment: message.body,
      },
      verifyWith: {
        tool: "fetch_pr_comments",
        arguments: {
          repo_full_name: locator.repoFullName,
          pr_number: locator.pullRequestNumber,
        },
        evidence: ["comment ID", "body hash", "pull request head"],
      },
    };
  }

  if (provider === "linear") {
    const entityFields = ["issueId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId"];
    const selected = entityFields.filter((name) => locator[name]);
    if (projection.action !== "REPLY" && selected.length !== 1) {
      throw new MessagingError("PROVIDER_LOCATOR_INCOMPLETE", "Linear top-level comment requires exactly one parent entity");
    }
    const args = { body: message.body };
    if (projection.action === "REPLY") {
      requireLocator(locator, ["parentId"], provider);
      args.parentId = locator.parentId;
    } else {
      args[selected[0]] = locator[selected[0]];
      if (selected[0] === "statusUpdateId" && locator.statusUpdateType) args.statusUpdateType = locator.statusUpdateType;
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "save_comment",
      arguments: args,
      verifyWith: {
        tool: "list_comments",
        arguments: projection.action === "REPLY"
          ? { issueId: locator.issueId ?? "$resolved_parent_entity", limit: 100 }
          : { [selected[0]]: locator[selected[0]], limit: 100 },
        evidence: ["comment ID", "body hash", "updatedAt"],
      },
    };
  }

  if (provider === "asana") {
    requireLocator(locator, ["taskId"], provider);
    if (projection.action === "REPLY") {
      throw new MessagingError("PROVIDER_CAPABILITY_UNSUPPORTED", "Current Asana tool surface does not expose threaded replies");
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "add_comment",
      arguments: {
        task_id: locator.taskId,
        text: message.body,
        is_pinned: Boolean(locator.pin),
      },
      verifyWith: {
        tool: "get_task",
        arguments: { task_id: locator.taskId, include_comments: true, comment_limit: 50 },
        evidence: ["story ID", "body hash", "created_at"],
      },
    };
  }

  if (provider === "notion") {
    requireLocator(locator, ["pageId"], provider);
    const args = { page_id: locator.pageId, markdown: message.body };
    if (projection.action === "REPLY") {
      requireLocator(locator, ["discussionId"], provider);
      args.discussion_id = locator.discussionId;
    } else if (locator.selectionWithEllipsis) {
      args.selection_with_ellipsis = locator.selectionWithEllipsis;
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "notion-create-comment",
      arguments: args,
      verifyWith: {
        tool: "notion-get-comments",
        arguments: {
          page_id: locator.pageId,
          include_all_blocks: true,
          include_resolved: true,
          ...(locator.discussionId ? { discussion_id: locator.discussionId } : {}),
        },
        evidence: ["discussion ID", "comment ID", "body hash"],
      },
    };
  }

  if (provider === "airtable") {
    requireLocator(locator, ["baseId", "tableId", "recordId"], provider);
    const args = {
      baseId: locator.baseId,
      tableId: locator.tableId,
      recordId: locator.recordId,
      text: message.body,
    };
    if (projection.action === "REPLY") {
      requireLocator(locator, ["parentCommentId"], provider);
      args.parentCommentId = locator.parentCommentId;
    }
    return {
      ...common,
      transport: "connected-tool",
      tool: "create_record_comment",
      arguments: args,
      verifyWith: {
        tool: "list_record_comments",
        arguments: {
          baseId: locator.baseId,
          tableId: locator.tableId,
          recordId: locator.recordId,
          pageSize: 100,
        },
        evidence: ["comment ID", "body hash", "created time"],
      },
    };
  }

  const chatSdk = definition.chatSdk;
  if (chatSdk) {
    requireLocator(locator, ["conversationId"], provider);
    return {
      ...common,
      transport: "vercel-chat-sdk",
      package: chatSdk.package,
      factory: chatSdk.factory,
      operation: projection.action === "REPLY" ? "thread.post" : "channel.post",
      arguments: {
        conversationId: locator.conversationId,
        threadId: locator.threadId ?? null,
        content: message.body,
      },
      verifyWith: {
        operation: "thread.messages",
        arguments: {
          conversationId: locator.conversationId,
          threadId: locator.threadId ?? "$provider_thread_id",
        },
        evidence: ["provider message ID", "body hash", "author identity"],
      },
      blockedUntil: definition.surfaceState === "ADAPTER_AVAILABLE_AUTH_UNCONFIGURED"
        ? ["adapter package installed", "provider app credentials configured", "webhook verification configured"]
        : [],
    };
  }

  return {
    ...common,
    transport: definition.transport,
    executable: false,
    reason: "NO_NATIVE_OPERATION_MAPPING",
  };
}
