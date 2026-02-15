import type { Bot } from "grammy";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { createPlaceholderController } from "../auto-reply/reply/placeholder.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixContext } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import { danger, logVerbose } from "../globals.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import { deliverReplies } from "./bot/delivery.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { markdownToTelegramHtml } from "./format.js";
import { sendMessageTelegram, deleteMessageTelegram, editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import { loadSessionStore } from "../config/sessions/store.ts";
import { resolveStorePath } from "../config/sessions.ts";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
};

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const draftMaxChars = Math.min(textLimit, 4096);
  const accountBlockStreamingEnabled =
    typeof telegramCfg.blockStreaming === "boolean"
      ? telegramCfg.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = streamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        maxChars: draftMaxChars,
        thread: threadSpec,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: DRAFT_MIN_INITIAL_CHARS,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const shouldSplitPreviewMessages = streamMode === "block";
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  let lastPartialText = "";
  let draftText = "";
  let draftReasoning = "";
  let draftToolStatus = "";
  let draftModelStatus = "";
  let lastToolName = "";
  let lastToolArgs = "";
  let isStreaming = true;

  const sessionStorePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const sessionRecord = loadSessionStore(sessionStorePath);
  const sessionEntry = sessionRecord[context.ctxPayload?.SessionKey ?? ""];
  let lastShownModel = sessionEntry?.model
    ? `${sessionEntry.modelProvider}/${sessionEntry.model}`
    : "";

  const escapeHtml = (unsafe: string) => {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };

  const TOOL_SNIPPET_MAX_CHARS = 1200;
  const TOOL_SNIPPET_MAX_LINES = 40;
  const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    diff: "diff",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    kt: "kotlin",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    yml: "yaml",
    yaml: "yaml",
  };

  const unescapeToolText = (text: string) => {
    if (text.includes("\n")) {
      return text;
    }
    if (!/\\[ntr]/.test(text)) {
      return text;
    }
    return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  };

  const truncateToolSnippet = (text: string) => {
    const normalized = text.replace(/\r\n/g, "\n");
    let lines = normalized.split("\n");
    let truncated = false;
    if (lines.length > TOOL_SNIPPET_MAX_LINES) {
      lines = lines.slice(0, TOOL_SNIPPET_MAX_LINES);
      truncated = true;
    }
    let joined = lines.join("\n");
    if (joined.length > TOOL_SNIPPET_MAX_CHARS) {
      joined = joined.slice(0, TOOL_SNIPPET_MAX_CHARS);
      truncated = true;
    }
    return { text: joined, truncated };
  };

  const inferToolLanguage = (filePath?: string) => {
    if (!filePath) {
      return undefined;
    }
    const basename = filePath.split("/").pop() ?? filePath;
    const parts = basename.split(".");
    if (parts.length < 2) {
      return undefined;
    }
    const ext = parts.at(-1)?.toLowerCase();
    return ext ? LANGUAGE_BY_EXTENSION[ext] : undefined;
  };

  const formatCodeBlock = (content: string, language?: string) => {
    const { text, truncated } = truncateToolSnippet(unescapeToolText(content));
    const langClass = language ? ` class="language-${language}"` : "";
    const suffix = truncated ? "\n<i>(truncated)</i>" : "";
    return `\n<pre><code${langClass}>${escapeHtml(text)}</code></pre>${suffix}`;
  };

  const formatToolArgs = (toolName: string, args: any) => {
    if (!args || typeof args !== "object" || Object.keys(args).length === 0) {
      return "";
    }

    const getArg = (...keys: string[]) => {
      for (const k of keys) {
        if (typeof args[k] === "string") {
          return args[k];
        }
      }
      return null;
    };

    // Web Search
    if (/^(search|google|duckduckgo)/i.test(toolName)) {
      const q = getArg("query", "q", "Query");
      if (q) {
        return `: ${escapeHtml(q)}`;
      }
    }

    // URL/Browser
    if (/^(browser|read_url|open_url)/i.test(toolName)) {
      const action = getArg("action", "Action");
      const url = getArg("url", "Url", "URL", "target", "targetUrl");

      // Handle action-only or action-focused calls
      if (action && !url) {
        return `: ${escapeHtml(action)}`;
      }

      if (url) {
        try {
          const u = new URL(url);
          // Detect search engines
          if (u.hostname.includes("google.") && u.searchParams.has("q")) {
            return `: Searching Google: ${escapeHtml(u.searchParams.get("q") ?? "")}`;
          }
          if (u.hostname.includes("duckduckgo.") && u.searchParams.has("q")) {
            return `: Searching DuckDuckGo: ${escapeHtml(u.searchParams.get("q") ?? "")}`;
          }
        } catch {
          // ignore invalid URLs
        }

        // If it's an 'open' action, just show the URL. For others, maybe prefix?
        // But readability is key. Just the URL is usually enough context.
        return `: Browsing: ${escapeHtml(url)}`;
      }
    }

    if (toolName === "read") {
      const filePath = getArg("path", "file_path");
      if (filePath) {
        const offset =
          typeof args.offset === "number"
            ? args.offset
            : typeof args.offset === "string"
              ? Number(args.offset)
              : undefined;
        const limit =
          typeof args.limit === "number"
            ? args.limit
            : typeof args.limit === "string"
              ? Number(args.limit)
              : undefined;
        const startLine = Number.isFinite(offset) ? Number(offset) : undefined;
        const endLine =
          Number.isFinite(limit) && Number.isFinite(startLine)
            ? Number(startLine) + Number(limit) - 1
            : undefined;
        const range =
          startLine != null ? ` (lines ${startLine}${endLine ? `-${endLine}` : ""})` : "";
        return `: Reading <code>${escapeHtml(filePath)}</code>${range}`;
      }
    }

    if (toolName === "write") {
      const filePath = getArg("path", "file_path");
      const content = getArg("content", "text");
      if (filePath && typeof content === "string") {
        const language = inferToolLanguage(filePath);
        return `: Writing <code>${escapeHtml(filePath)}</code>${formatCodeBlock(
          content,
          language,
        )}`;
      }
    }

    if (toolName === "edit") {
      const filePath = getArg("path", "file_path");
      const content = getArg("newText", "new_string");
      if (filePath && typeof content === "string") {
        const language = inferToolLanguage(filePath);
        return `: Editing <code>${escapeHtml(filePath)}</code>${formatCodeBlock(
          content,
          language,
        )}`;
      }
    }

    // Browser Subagent
    if (toolName === "browser_subagent") {
      const task = getArg("Task", "task");
      if (task) {
        return `: ${escapeHtml(task)}`;
      }
    }

    // Command Execution
    if (/^(run_command|exec|terminal|execute)/i.test(toolName)) {
      const cmd = getArg("command", "CommandLine", "cmd", "code");
      if (cmd) {
        // If command is multi-line, use pre block for better readability
        if (cmd.includes("\n") || cmd.length > 50) {
          return `:\n<pre><code>${escapeHtml(cmd)}</code></pre>`;
        }
        return `: <code>${escapeHtml(cmd)}</code>`;
      }
    }

    return `: <code>${escapeHtml(JSON.stringify(args))}</code>`;
  };

  const updateDraftCombined = () => {
    if (!draftStream) {
      return;
    }
    let combined = "";
    if (draftModelStatus) {
      combined += `${draftModelStatus}\n\n`;
    }
    if (draftToolStatus) {
      combined += `${draftToolStatus}\n\n`;
    }

    // Show thinking indicator if we're streaming and either:
    // 1. We have no content at all (initial thinking)
    // 2. We just finished a tool and are waiting for the AI to process the result
    const justFinishedTool =
      draftToolStatus.includes("finished") || draftToolStatus.includes("failed");
    if (isStreaming && !draftText && !draftReasoning && (!draftToolStatus || justFinishedTool)) {
      combined += "<i>Thinking...</i>";
    }

    if (draftReasoning) {
      // Use markdownToTelegramHtml which already uses <blockquote expandable> for thoughts/reasoning
      combined += `${markdownToTelegramHtml(draftReasoning)}\n`;
    }

    if (draftText) {
      combined += markdownToTelegramHtml(draftText);
    }

    // Add a blinking cursor (dot) if we're still streaming content
    if (isStreaming && (draftText || draftReasoning)) {
      combined += " ●";
    }

    draftStream.update(combined.trim());
  };
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    hasStreamedMessage = true;
    if (streamMode === "partial") {
      // Some providers briefly emit a shorter prefix snapshot (for example
      // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
      // visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(text) &&
        text.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = text;
      draftText = text;
      updateDraftCombined();
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Non-monotonic stream (e.g. sanitizer changed output shape).
      // Recover by using the full `text` as the new baseline instead of
      // losing all previously accumulated content.
      draftChunker?.reset();
      draftText = "";
      delta = text;
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      updateDraftCombined();
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        updateDraftCombined();
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    isStreaming = false;
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText || draftReasoning || draftToolStatus) {
        updateDraftCombined();
      }
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    typeof telegramCfg.blockStreaming === "boolean"
      ? !telegramCfg.blockStreaming
      : draftStream || streamMode === "off"
        ? true
        : undefined;

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };
  let finalizedViaPreviewMessage = false;
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteText,
  };

  let queuedFinal = false;
  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            await flushDraft();
            const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
            const previewMessageId = draftStream?.messageId();
            const finalText = payload.text;
            const currentPreviewText = streamMode === "block" ? draftText : lastPartialText;
            const previewButtons = (
              payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
            )?.buttons;
            let draftStoppedForPreviewEdit = false;
            // Skip preview edit for error payloads to avoid overwriting previous content
            const canFinalizeViaPreviewEdit =
              !finalizedViaPreviewMessage &&
              !hasMedia &&
              typeof finalText === "string" &&
              finalText.length > 0 &&
              typeof previewMessageId === "number" &&
              finalText.length <= draftMaxChars &&
              !payload.isError;
            if (canFinalizeViaPreviewEdit) {
              await draftStream?.stop();
              draftStoppedForPreviewEdit = true;
              if (
                currentPreviewText &&
                currentPreviewText.startsWith(finalText) &&
                finalText.length < currentPreviewText.length
              ) {
                // Ignore regressive final edits (e.g., "Okay." -> "Ok"), which
                // can appear transiently in some provider streams.
                return;
              }
              try {
                await editMessageTelegram(chatId, previewMessageId, finalText, {
                  api: bot.api,
                  cfg,
                  accountId: route.accountId,
                  linkPreview: telegramCfg.linkPreview,
                  buttons: previewButtons,
                });
                finalizedViaPreviewMessage = true;
                deliveryState.delivered = true;
                return;
              } catch (err) {
                logVerbose(
                  `telegram: preview final edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }
            if (
              !hasMedia &&
              !payload.isError &&
              typeof finalText === "string" &&
              finalText.length > draftMaxChars
            ) {
              logVerbose(
                `telegram: preview final too long for edit (${finalText.length} > ${draftMaxChars}); falling back to standard send`,
              );
            }
            if (!draftStoppedForPreviewEdit) {
              await draftStream?.stop();
            }
            // Check if stop() sent a message (debounce released on isFinal)
            // If so, edit that message instead of sending a new one
            const messageIdAfterStop = draftStream?.messageId();
            if (
              !finalizedViaPreviewMessage &&
              typeof messageIdAfterStop === "number" &&
              typeof finalText === "string" &&
              finalText.length > 0 &&
              finalText.length <= draftMaxChars &&
              !hasMedia &&
              !payload.isError
            ) {
              try {
                await editMessageTelegram(chatId, messageIdAfterStop, finalText, {
                  api: bot.api,
                  cfg,
                  accountId: route.accountId,
                  linkPreview: telegramCfg.linkPreview,
                  buttons: previewButtons,
                });
                finalizedViaPreviewMessage = true;
                deliveryState.delivered = true;
                return;
              } catch (err) {
                logVerbose(
                  `telegram: post-stop preview edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }
          }
          const result = await deliverReplies({
            ...deliveryBaseOptions,
            replies: [payload],
            onVoiceRecording: sendRecordVoice,
          });
          if (result.delivered) {
            deliveryState.delivered = true;
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.skippedNonSilent += 1;
          }
        },
        onError: (err, info) => {
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
        },
        onReplyStart: createTypingCallbacks({
          start: sendTyping,
          onStartError: (err) => {
            logTypingFailure({
              log: logVerbose,
              channel: "telegram",
              target: String(chatId),
              error: err,
            });
          },
        }).onReplyStart,
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
        onAssistantMessageStart: draftStream
          ? () => {
              // Only split preview bubbles in block mode. In partial mode, keep
              // editing one preview message to avoid flooding the chat.
              logVerbose(
                `telegram: onAssistantMessageStart called, hasStreamedMessage=${hasStreamedMessage}`,
              );
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                logVerbose(`telegram: calling forceNewMessage()`);
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onReasoningEnd: draftStream
          ? () => {
              // Same policy as assistant-message boundaries: split only in block mode.
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onModelSelected,
      },
    }));
  } finally {
    // Must stop() first to flush debounced content before clear() wipes state
    await draftStream?.stop();
    if (!finalizedViaPreviewMessage) {
      await draftStream?.clear();
    }
  }
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      ...deliveryBaseOptions,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;
  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  clearGroupHistory();
};
