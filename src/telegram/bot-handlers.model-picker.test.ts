import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { registerTelegramHandlers } from "./bot-handlers.js";

const sessionStores = new Map<string, Record<string, unknown>>();

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: (_store: unknown, params: { agentId: string }) => `store:${params.agentId}`,
  loadSessionStore: (path: string) => sessionStores.get(path) ?? {},
  saveSessionStore: async (path: string, store: Record<string, unknown>) => {
    sessionStores.set(path, store);
  },
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
}));

describe("telegram model picker (DM)", () => {
  beforeEach(() => {
    sessionStores.clear();
  });

  it("stores model override from inline keyboard in DM", async () => {
    const callbacks = new Map<string, (ctx: any) => Promise<void>>();
    const bot = {
      api: {
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageText: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendChatAction: vi.fn().mockResolvedValue(undefined),
      },
      on: vi.fn((event: string, handler: (ctx: any) => Promise<void>) => {
        callbacks.set(event, handler);
      }),
      command: vi.fn(),
    };

    const cfg = {
      channels: {
        telegram: {
          accounts: {
            default: {
              capabilities: { inlineButtons: "all" },
              dmPolicy: "open",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    registerTelegramHandlers({
      cfg,
      accountId: "default",
      bot: bot as any,
      opts: { token: "token" },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit ${code}`);
        }) as never,
      },
      mediaMaxBytes: 10_000_000,
      telegramCfg: {
        capabilities: { inlineButtons: "all" },
        dmPolicy: "open",
      } as any,
      groupAllowFrom: [],
      channelAllowFrom: [],
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveChannelPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({}),
      resolveTelegramChannelConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage: vi.fn(),
      logger: { info: vi.fn() } as any,
    });

    const handler = callbacks.get("callback_query");
    expect(handler).toBeDefined();

    const chatId = 12345;
    const modelKey = "openai/gpt-4o-mini";

    await handler?.({
      callbackQuery: {
        id: "cb-1",
        data: `mp:${modelKey}`,
        from: { id: 999, username: "tester" },
        message: {
          message_id: 42,
          chat: { id: chatId, type: "private" },
          is_forum: false,
        },
      },
    });

    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "direct", id: String(chatId) },
    });

    const storePath = `store:${route.agentId}`;
    const store = sessionStores.get(storePath) as Record<string, any> | undefined;
    expect(store).toBeDefined();
    const session = store?.[route.sessionKey];
    expect(session?.providerOverride).toBe("openai");
    expect(session?.modelOverride).toBe("gpt-4o-mini");
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      chatId,
      42,
      `Use <b>${modelKey}</b> for this chat.`,
      { parse_mode: "HTML" },
    );
  });
});
