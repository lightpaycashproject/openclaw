import type { Message, ReactionTypeEmoji } from "@grammyjs/types";
// @ts-nocheck
import type { TelegramContext } from "./bot/types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildModelsProviderData } from "../auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { loadConfig } from "../config/config.js";
import { writeConfigFile } from "../config/io.js";
import { loadSessionStore, resolveStorePath, saveSessionStore } from "../config/sessions.js";
import type { TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import { danger, logVerbose, warn } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  firstDefined,
  isSenderAllowed,
  normalizeAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { MEDIA_GROUP_TIMEOUT_MS, type MediaGroupEntry } from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
} from "./bot/helpers.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess,
} from "./group-access.js";
import { buildModelPickerMessage, buildProviderPickerMessage } from "./commands/model-picker.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";
import { wasSentByBot } from "./sent-message-cache.js";

export const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger,
}: RegisterTelegramHandlerParams) => {
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4000;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS =
    typeof opts.testTimings?.textFragmentGapMs === "number" &&
    Number.isFinite(opts.testTimings.textFragmentGapMs)
      ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs))
      : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 50_000;
  const mediaGroupTimeoutMs =
    typeof opts.testTimings?.mediaGroupFlushMs === "number" &&
    Number.isFinite(opts.testTimings.mediaGroupFlushMs)
      ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs))
      : MEDIA_GROUP_TIMEOUT_MS;

  const mediaGroupBuffer = new Map<string, MediaGroupEntry>();
  let mediaGroupProcessing: Promise<void> = Promise.resolve();

  type TextFragmentEntry = {
    key: string;
    messages: Array<{ msg: Message; ctx: TelegramContext; receivedAtMs: number }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const textFragmentBuffer = new Map<string, TextFragmentEntry>();
  let textFragmentProcessing: Promise<void> = Promise.resolve();

  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  type TelegramDebounceEntry = {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    storeAllowFrom: string[];
    debounceKey: string | null;
    botUsername?: string;
  };

  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });

  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me"> & { getFile?: unknown; api?: any },
    message: Message,
  ): TelegramContext => {
    const getFile =
      typeof ctx.getFile === "function"
        ? (ctx.getFile as TelegramContext["getFile"]).bind(ctx as object)
        : async () => ({});
    return { ...ctx, message, me: ctx.me, getFile } as unknown as TelegramContext;
  };

  const loadStoreAllowFrom = async () =>
    readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);

  const inboundDebouncer = createInboundDebouncer<TelegramDebounceEntry>({
    debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      if (entry.allMedia.length > 0) return false;
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      if (!text.trim()) return false;
      return !hasControlCommand(text, cfg, { botUsername: entry.botUsername });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.msg.text ?? entry.msg.caption ?? "")
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) return;

      const first = entries[0];
      const baseCtx = first.ctx;
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });
      const messageIdOverride = last.msg.message_id != null ? String(last.msg.message_id) : undefined;
      await processMessage(
        buildSyntheticContext(baseCtx, syntheticMessage),
        [],
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : undefined,
      );
    },
    onError: (err) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
    },
  });

  const resolveTelegramSessionModel = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
  }): string | undefined => {
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const peerId = params.isGroup
      ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
      : String(params.chatId);
    const parentPeer = buildTelegramParentPeer({
      isGroup: params.isGroup,
      resolvedThreadId,
      chatId: params.chatId,
    });
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId,
      peer: {
        kind: params.isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });
    const baseSessionKey = route.sessionKey;
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const threadKeys =
      dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
    });
    if (storedOverride) {
      return storedOverride.provider
        ? `${storedOverride.provider}/${storedOverride.model}`
        : storedOverride.model;
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) return `${provider}/${model}`;
    const modelCfg = cfg.agents?.defaults?.model;
    return typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
  };

  const processMediaGroup = async (entry: MediaGroupEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];

      const allMedia: TelegramMediaRef[] = [];
      for (const { ctx } of entry.messages) {
        const media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          });
        }
      }

      const storeAllowFrom = await loadStoreAllowFrom();
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };

  const flushTextFragments = async (entry: TextFragmentEntry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) return;

      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) return;

      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date,
      });

      const storeAllowFrom = await loadStoreAllowFrom();
      const baseCtx = first.ctx;

      await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id),
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };

  const queueTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentProcessing = textFragmentProcessing
      .then(async () => {
        await flushTextFragments(entry);
      })
      .catch(() => undefined);
    await textFragmentProcessing;
  };

  const runTextFragmentFlush = async (entry: TextFragmentEntry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };

  const scheduleTextFragmentFlush = (entry: TextFragmentEntry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };
  
  const isAllowlistAuthorized = (
    allow: NormalizedAllowFrom,
    senderId: string,
    senderUsername: string,
  ) =>
    allow.hasWildcard ||
    (allow.hasEntries &&
      isSenderAllowed({
        allow,
        senderId,
        senderUsername,
      }));

  const shouldSkipGroupMessage = (params: {
    isGroup: boolean;
    chatId: string | number;
    chatTitle?: string;
    resolvedThreadId?: number;
    senderId: string;
    senderUsername: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
  }) => {
    const {
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig,
    } = params;
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true,
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`,
      );
      return true;
    }
    if (!isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup,
      chatId,
      cfg,
      telegramCfg,
      topicConfig,
      groupConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true,
    });
    if (!policyAccess.allowed) {
      if (policyAccess.reason === "group-policy-disabled") {
        logVerbose("Blocked telegram group message (groupPolicy: disabled)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-no-sender") {
        logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-empty") {
        logVerbose(
          "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)",
        );
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
        logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
        return true;
      }
      logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
      return true;
    }
    return false;
  };

  // Handle emoji reactions to messages.
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }

      const chatId = reaction.chat.id;
      const messageId = reaction.message_id;
      const user = reaction.user;

      // Resolve reaction notification mode (default: "own").
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (reactionMode === "own" && !wasSentByBot(chatId, messageId)) {
        return;
      }

      // Detect added reactions.
      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
          .map((r) => r.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
        .filter((r) => !oldEmojis.has(r.emoji));

      if (addedReactions.length === 0) {
        return;
      }

      // Build sender label.
      const senderName = user
        ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
        : undefined;
      const senderUsername = user?.username ? `@${user.username}` : undefined;
      let senderLabel = senderName;
      if (senderName && senderUsername) {
        senderLabel = `${senderName} (${senderUsername})`;
      } else if (!senderName && senderUsername) {
        senderLabel = senderUsername;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";

      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const isForum = reaction.chat.is_forum === true;
      const resolvedThreadId = isForum
        ? resolveTelegramForumThreadId({ isForum, messageThreadId: undefined })
        : undefined;
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
      const route = resolveAgentRoute({
        cfg: loadConfig(),
        channel: "telegram",
        accountId,
        peer: { kind: isGroup ? "group" : "direct", id: peerId },
        parentPeer,
      });
      const sessionKey = route.sessionKey;

      for (const r of addedReactions) {
        const emoji = r.emoji;
        const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
    }
  });

  const processInboundMessage = async (params: {
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    resolvedThreadId?: number;
    storeAllowFrom: string[];
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
  }) => {
    const {
      ctx,
      msg,
      chatId,
      resolvedThreadId,
      storeAllowFrom,
      sendOversizeWarning,
      oversizeLogMessage,
    } = params;

    const text = typeof msg.text === "string" ? msg.text : undefined;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike) {
      const nowMs = Date.now();
      const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
      const key = `text:${chatId}:${resolvedThreadId ?? "main"}:${senderId}`;
      const existing = textFragmentBuffer.get(key);

      if (existing) {
        const last = existing.messages.at(-1);
        const lastMsgId = last?.msg.message_id;
        const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
        const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
        const timeGapMs = nowMs - lastReceivedAtMs;
        const canAppend =
          idGap > 0 &&
          idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP &&
          timeGapMs >= 0 &&
          timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;

        if (canAppend) {
          const currentChars = existing.messages.reduce((sum, m) => sum + (m.msg.text?.length ?? 0), 0);
          if (
            existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS &&
            (currentChars + text.length) <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS
          ) {
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            scheduleTextFragmentFlush(existing);
            return;
          }
        }
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        textFragmentProcessing = textFragmentProcessing.then(() => flushTextFragments(existing)).catch(() => {});
      }

      if (text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS) {
        const entry: TextFragmentEntry = { key, messages: [{ msg, ctx, receivedAtMs: nowMs }], timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS) };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    }

    if (msg.media_group_id) {
      const existing = mediaGroupBuffer.get(msg.media_group_id);
      if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.timer = setTimeout(() => {
          mediaGroupBuffer.delete(msg.media_group_id!);
          mediaGroupProcessing = mediaGroupProcessing.then(() => processMediaGroup(existing)).catch(() => {});
        }, mediaGroupTimeoutMs);
      } else {
        const entry: MediaGroupEntry = {
          messages: [{ msg, ctx }],
          timer: setTimeout(() => {
            mediaGroupBuffer.delete(msg.media_group_id!);
            mediaGroupProcessing = mediaGroupProcessing.then(() => processMediaGroup(entry)).catch(() => {});
          }, mediaGroupTimeoutMs),
        };
        mediaGroupBuffer.set(msg.media_group_id, entry);
      }
      return;
    }

    let media = null;
    try {
      media = await resolveMedia(ctx, mediaMaxBytes, opts.token, opts.proxyFetch);
    } catch (mediaErr) {
      if (String(mediaErr).includes("MB limit") && sendOversizeWarning) {
        await bot.api.sendMessage(chatId, `⚠️ File too large. Maximum is ${Math.round(mediaMaxBytes / 1048576)}MB.`, { reply_to_message_id: msg.message_id }).catch(() => {});
      }
      return;
    }

    const allMedia = media ? [{ path: media.path, contentType: media.contentType, stickerMetadata: media.stickerMetadata }] : [];
    const conversationKey = resolvedThreadId != null ? `${chatId}:topic:${resolvedThreadId}` : String(chatId);
    const debounceKey = msg.from?.id ? `telegram:${accountId ?? "default"}:${conversationKey}:${msg.from.id}` : null;
    await inboundDebouncer.enqueue({ ctx, msg, allMedia, storeAllowFrom, debounceKey, botUsername: ctx.me?.username });
  };

  // HANDLERS
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction || shouldSkipUpdate(ctx)) return;
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off" || reaction.user?.is_bot) return;
      if (reactionMode === "own" && !wasSentByBot(reaction.chat.id, reaction.message_id)) return;

      const oldEmojis = new Set(reaction.old_reaction.filter((r): r is ReactionTypeEmoji => r.type === "emoji").map(r => r.emoji));
      const added = reaction.new_reaction.filter((r): r is ReactionTypeEmoji => r.type === "emoji" && !oldEmojis.has(r.emoji));
      if (added.length === 0) return;

      const user = reaction.user;
      const label = user ? ([user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || `id:${user.id}`) : "unknown";
      const isGroup = reaction.chat.type !== "private";
      const resThreadId = reaction.chat.is_forum ? resolveTelegramForumThreadId({ isForum: true, messageThreadId: undefined }) : undefined;
      const route = resolveAgentRoute({ cfg: loadConfig(), channel: "telegram", accountId, peer: { kind: isGroup ? "group" : "direct", id: isGroup ? buildTelegramGroupPeerId(reaction.chat.id, resThreadId) : String(reaction.chat.id) } });

      for (const r of added) {
        enqueueSystemEvent(`Telegram reaction: ${r.emoji} by ${label}`, { sessionKey: route.sessionKey, contextKey: `react:${reaction.chat.id}:${reaction.message_id}:${user?.id}:${r.emoji}` });
      }
    } catch (err) { runtime.error?.(danger(`Reaction handler failed: ${String(err)}`)); }
  });

  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback || !callback.message || !("chat" in callback.message)) return;
    if (shouldSkipUpdate(ctx)) return;
    const msg = callback.message as Message;

    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: () => ctx.answerCallbackQuery().catch(() => bot.api.answerCallbackQuery(callback.id)),
    }).catch(() => {});

    try {
      const data = (callback.data ?? "").trim();
      if (!data) return;

      const inlineButtonsScope = resolveTelegramInlineButtonsScope({ cfg, accountId });
      if (inlineButtonsScope === "off") return;

      const chatId = msg.chat.id;
      const isGroup = msg.chat.type !== "private";
      if ((inlineButtonsScope === "dm" && isGroup) || (inlineButtonsScope === "group" && !isGroup)) return;

      const groupAllowContext = await resolveTelegramGroupAllowFromContext({
        chatId, accountId, isForum: msg.chat.is_forum === true,
        messageThreadId: msg.message_thread_id, groupAllowFrom, resolveTelegramGroupConfig,
      });

      const { resolvedThreadId, storeAllowFrom, groupConfig, topicConfig, effectiveGroupAllow, hasGroupAllowOverride } = groupAllowContext;
      const senderId = callback.from.id ? String(callback.from.id) : "";
      const senderUsername = callback.from.username ?? "";

      if (shouldSkipGroupMessage({ isGroup, chatId, chatTitle: msg.chat.title, resolvedThreadId, senderId, senderUsername, effectiveGroupAllow, hasGroupAllowOverride, groupConfig, topicConfig })) return;

      if (inlineButtonsScope === "allowlist") {
        const allow = isGroup ? effectiveGroupAllow : normalizeAllowFromWithStore({ allowFrom: telegramCfg.allowFrom, storeAllowFrom });
        if (!isAllowlistAuthorized(allow, senderId, senderUsername)) return;
      }

      // 1. Pagination
      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        if (paginationMatch[1] === "noop") return;
        const page = parseInt(paginationMatch[1], 10);
        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg) || undefined;
        const result = buildCommandsMessagePaginated(cfg, listSkillCommandsForAgents({ cfg, agentIds: agentId ? [agentId] : undefined }), { page, surface: "telegram" });
        const keyboard = result.totalPages > 1 ? buildInlineKeyboard(buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)) : undefined;
        await ctx.editMessageText(result.text, { reply_markup: keyboard }).catch(() => {});
        return;
      }

      // 2. Model Selection (Helper-based)
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const { byProvider, providers } = await buildModelsProviderData(cfg);
        const editOrReply = async (text: string, buttons: any) => {
          const markup = buildInlineKeyboard(buttons);
          try {
            await ctx.editMessageText(text, { reply_markup: markup });
          } catch (e) {
            if (String(e).includes("no text")) {
              await ctx.deleteMessage().catch(() => {});
              await ctx.reply(text, { reply_markup: markup });
            }
          }
        };

        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          await editOrReply("Select a provider:", buildProviderKeyboard(providers.map(p => ({ id: p, count: byProvider.get(p)?.size ?? 0 }))));
        } else if (modelCallback.type === "list") {
          const models = [...(byProvider.get(modelCallback.provider) ?? [])].toSorted();
          const current = resolveTelegramSessionModel({ chatId, isGroup, isForum: msg.chat.is_forum === true, messageThreadId: msg.message_thread_id, resolvedThreadId });
          await editOrReply(`Models (${modelCallback.provider})`, buildModelsKeyboard({ provider: modelCallback.provider, models, currentModel: current, currentPage: modelCallback.page, totalPages: calculateTotalPages(models.length, getModelsPageSize()), pageSize: getModelsPageSize() }));
        } else if (modelCallback.type === "select") {
          await processMessage(buildSyntheticContext(ctx, buildSyntheticTextMessage({ base: msg, from: callback.from, text: `/model ${modelCallback.provider}/${modelCallback.model}` })), [], storeAllowFrom, { forceWasMentioned: true, messageIdOverride: callback.id });
        }
        return;
      }

      // 3. Regex matches
      const modelPickMatch = data.match(/^(?:model_pick|mp):(.+)$/);
      if (modelPickMatch) {
        const modelKey = modelPickMatch[1];
        const route = resolveAgentRoute({ cfg, channel: "telegram", accountId, peer: { kind: isGroup ? "group" : "direct", id: isGroup ? buildTelegramGroupPeerId(chatId, msg.message_thread_id) : String(chatId) } });
        const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
        const store = loadSessionStore(storePath);
        if (!store[route.sessionKey]) store[route.sessionKey] = { sessionId: Math.random().toString(36).slice(2), updatedAt: Date.now() };
        const parts = modelKey.trim().split("/");
        if (parts.length >= 2) {
          store[route.sessionKey].providerOverride = parts[0];
          store[route.sessionKey].modelOverride = parts.slice(1).join("/");
          store[route.sessionKey].updatedAt = Date.now();
          await saveSessionStore(storePath, store);
        }
        await ctx.editMessageText(`Use <b>${modelKey}</b>.`, { parse_mode: "HTML" }).catch(() => {});
        return;
      }

      const modelPageMatch = data.match(/^(?:model_page|pg):(.+):(\d+)$/);
      if (modelPageMatch) {
        const route = resolveAgentRoute({ cfg, channel: "telegram", accountId, peer: { kind: isGroup ? "group" : "direct", id: isGroup ? buildTelegramGroupPeerId(chatId, msg.message_thread_id) : String(chatId) } });
        const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: route.agentId }));
        const currentModel = store[route.sessionKey]?.providerOverride ? `${store[route.sessionKey].providerOverride}/${store[route.sessionKey].modelOverride}` : undefined;
        const picker = await buildModelPickerMessage({ cfg, page: parseInt(modelPageMatch[2], 10), provider: modelPageMatch[1], currentModel, agentId: route.agentId });
        await ctx.editMessageText(picker.text, { parse_mode: "HTML", reply_markup: picker.reply_markup }).catch(() => {});
        return;
      }

      const provPickMatch = data.match(/^(?:prov_pick|pp):(.+)$/);
      if (provPickMatch) {
        const route = resolveAgentRoute({ cfg, channel: "telegram", accountId, peer: { kind: isGroup ? "group" : "direct", id: isGroup ? buildTelegramGroupPeerId(chatId, msg.message_thread_id) : String(chatId) } });
        const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: route.agentId }));
        const currentModel = store[route.sessionKey]?.providerOverride ? `${store[route.sessionKey].providerOverride}/${store[route.sessionKey].modelOverride}` : undefined;
        const picker = await buildModelPickerMessage({ cfg, page: 1, provider: provPickMatch[1], currentModel, agentId: route.agentId });
        await ctx.editMessageText(picker.text, { parse_mode: "HTML", reply_markup: picker.reply_markup }).catch(() => {});
        return;
      }

      if (data === "prov_list" || data === "pl") {
        const picker = await buildProviderPickerMessage({ cfg });
        await ctx.editMessageText(picker.text, { parse_mode: "HTML", reply_markup: picker.reply_markup }).catch(() => {});
        return;
      }

      await processMessage(buildSyntheticContext(ctx, { ...msg, from: callback.from, text: data } as Message), [], storeAllowFrom, { forceWasMentioned: true, messageIdOverride: callback.id });
    } catch (err) { runtime.error?.(danger(`Callback query handler failed: ${String(err)}`)); }
  });

  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id || shouldSkipUpdate(ctx)) return;
      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) return;
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({ cfg: currentConfig, accountId, oldChatId: String(msg.chat.id), newChatId: String(msg.migrate_to_chat_id) });
      if (migration.migrated) await writeConfigFile(currentConfig);
    } catch (err) { runtime.error?.(danger(`Group migration failed: ${String(err)}`)); }
  });

  bot.command("models", async (ctx) => {
    if (shouldSkipUpdate(ctx)) return;
    try {
      const isGroup = ctx.chat.type !== "private";
      const route = resolveAgentRoute({ cfg, channel: "telegram", accountId, peer: { kind: isGroup ? "group" : "direct", id: isGroup ? buildTelegramGroupPeerId(ctx.chat.id, ctx.message?.message_thread_id) : String(ctx.chat.id) } });
      const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: route.agentId }));
      const message = await buildProviderPickerMessage({ cfg, currentProvider: store[route.sessionKey]?.providerOverride });
      await ctx.reply(message.text, { parse_mode: "HTML", reply_markup: message.reply_markup, message_thread_id: ctx.message?.message_thread_id });
    } catch (err) { runtime.error?.(danger(`Models command failed: ${String(err)}`)); }
  });

  bot.on("message", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg || shouldSkipUpdate(ctx)) return;
      const groupContext = await resolveTelegramGroupAllowFromContext({ chatId: msg.chat.id, accountId, isForum: msg.chat.is_forum === true, messageThreadId: msg.message_thread_id, groupAllowFrom, resolveTelegramGroupConfig });
      if (shouldSkipGroupMessage({ isGroup: msg.chat.type !== "private", chatId: msg.chat.id, chatTitle: msg.chat.title, senderId: msg.from ? String(msg.from.id) : "", senderUsername: msg.from?.username ?? "", ...groupContext })) return;
      await processInboundMessage({ ctx, msg, chatId: msg.chat.id, resolvedThreadId: groupContext.resolvedThreadId, storeAllowFrom: groupContext.storeAllowFrom, sendOversizeWarning: true, oversizeLogMessage: "media exceeds limit" });
    } catch (err) { runtime.error?.(danger(`Message handler failed: ${String(err)}`)); }
  });

  bot.on("channel_post", async (ctx) => {
    try {
      const post = ctx.channelPost;
      if (!post || shouldSkipUpdate(ctx)) return;
      const groupContext = await resolveTelegramGroupAllowFromContext({ chatId: post.chat.id, accountId, isForum: false, groupAllowFrom, resolveTelegramGroupConfig });
      if ((resolveGroupPolicy(post.chat.id).allowlistEnabled && !resolveGroupPolicy(post.chat.id).allowed) || groupContext.groupConfig?.enabled === false) return;

      const syntheticFrom = post.sender_chat ? { id: post.sender_chat.id, is_bot: true, first_name: post.sender_chat.title || "Channel" } : { id: post.chat.id, is_bot: true, first_name: "Channel" };
      const syntheticMsg = { ...post, from: post.from ?? syntheticFrom, chat: { ...post.chat, type: "supergroup" } } as Message;

      await processInboundMessage({
        ctx: buildSyntheticContext(ctx, syntheticMsg),
        msg: syntheticMsg, chatId: post.chat.id, storeAllowFrom: groupContext.storeAllowFrom,
        sendOversizeWarning: false, oversizeLogMessage: "channel post media"
      });
    } catch (err) { runtime.error?.(danger(`Channel handler failed: ${String(err)}`)); }
  });
};
