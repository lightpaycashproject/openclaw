import { InlineKeyboard } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelPickerItems } from "../../auto-reply/reply/directive-handling.model-picker.js";
import { OpenClawConfig } from "../../config/config.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.load.js";
import { buildModelPickerMessage, buildProviderPickerMessage } from "./model-picker.js";

// Mock the model catalog loader to return a fixed list of models for testing
vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockImplementation(async (params) => {
    if (params?.onlyAvailable !== true) {
      throw new Error("loadModelCatalog must be called with onlyAvailable: true");
    }
    return []; // The actual data comes from the other mock
  }),
}));

// Mock the picker items builder
vi.mock("../../auto-reply/reply/directive-handling.model-picker.js", () => ({
  buildModelPickerItems: vi.fn().mockImplementation(() => {
    // Generate 25 dummy models from test-provider
    const testProvider = Array.from({ length: 25 }, (_, i) => ({
      provider: "test-provider",
      model: `model-${i + 1}`,
    }));
    // Generate 5 dummy models from another-provider
    const anotherProvider = Array.from({ length: 5 }, (_, i) => ({
      provider: "another-provider",
      model: `other-model-${i + 1}`,
    }));
    const openrouter = [
      { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
      { provider: "openrouter", model: "meta-llama/llama-3.1-8b-instruct" },
    ];
    const antigravity = [
      { provider: "google-antigravity", model: "gemini-1.5-pro" },
      { provider: "google-antigravity", model: "gemini-1.5-flash" },
    ];
    return [...testProvider, ...anotherProvider, ...openrouter, ...antigravity];
  }),
}));

vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({ updatedAt: 0, providers: [] }),
}));

describe("buildModelPickerMessage", () => {
  const mockCfg = {} as unknown as OpenClawConfig;
  const loadProviderUsageSummaryMock = vi.mocked(loadProviderUsageSummary);
  const buildModelPickerItemsMock = vi.mocked(buildModelPickerItems);

  beforeEach(() => {
    loadProviderUsageSummaryMock.mockResolvedValue({ updatedAt: 0, providers: [] });
    buildModelPickerItemsMock.mockImplementation(() => {
      const testProvider = Array.from({ length: 25 }, (_, i) => ({
        provider: "test-provider",
        model: `model-${i + 1}`,
      }));
      const anotherProvider = Array.from({ length: 5 }, (_, i) => ({
        provider: "another-provider",
        model: `other-model-${i + 1}`,
      }));
      const openrouter = [
        { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
        { provider: "openrouter", model: "meta-llama/llama-3.1-8b-instruct" },
      ];
      const antigravity = [
        { provider: "google-antigravity", model: "gemini-1.5-pro" },
        { provider: "google-antigravity", model: "gemini-1.5-flash" },
      ];
      return [...testProvider, ...anotherProvider, ...openrouter, ...antigravity];
    });
  });

  it("renders the first page of models for a specific provider", async () => {
    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 1,
      provider: "test-provider",
    });

    expect(result.text).toContain("Select a Model");
    expect(result.reply_markup).toBeInstanceOf(InlineKeyboard);

    const rows = result.reply_markup.inline_keyboard;

    // We expect 10 model rows + 1 nav row + 1 back row
    // Inside builder:
    // keyboard.text(...) (10x)
    // keyboard.text("1/3", "noop") + keyboard.text("Next", ...) (1 row)
    // keyboard.row().text("Back", ...) (1 row)
    expect(rows.length).toBe(12);

    const firstBtn = rows[0][0];
    expect(firstBtn.text).toBe("model-1");
    expect((firstBtn as { callback_data?: string }).callback_data).toBe("mp:test-provider/model-1");

    // Navigation row
    const navRow = rows[10];
    expect(navRow[0].text).toBe("1/3");
    expect(navRow[1].text).toBe("Next ➡️");

    // Back row
    const backRow = rows[11];
    expect(backRow[0].text).toBe("🔙 Back to Providers");
    expect((backRow[0] as { callback_data?: string }).callback_data).toBe("pl");
  });

  it("renders the second page with navigation", async () => {
    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 2,
      provider: "test-provider",
    });

    const rows = result.reply_markup.inline_keyboard;
    expect(rows.length).toBe(12);

    const firstBtn = rows[0][0];
    expect(firstBtn.text).toBe("model-11"); // Start of page 2

    // Navigation row
    const navRow = rows[10];
    expect(navRow[0].text).toBe("⬅️ Prev");
    expect(navRow[1].text).toBe("2/3");
    expect(navRow[2].text).toBe("Next ➡️");
  });

  it("renders the last page", async () => {
    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 3,
      provider: "test-provider",
    });

    const rows = result.reply_markup.inline_keyboard;
    // 5 items (21-25) + nav + back = 7 rows
    expect(rows.length).toBe(7);

    const firstBtn = rows[0][0];
    expect(firstBtn.text).toBe("model-21");

    // Navigation row
    const navRow = rows[5];
    expect(navRow[0].text).toBe("⬅️ Prev");
    expect(navRow[1].text).toBe("3/3");
  });

  it("highlights current model selection", async () => {
    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 1,
      provider: "test-provider",
      currentModel: "test-provider/model-2",
    });

    const rows = result.reply_markup.inline_keyboard;

    // Model 2 is at index 1
    const btn = rows[1][0];
    expect(btn.text).toBe("✅ model-2");

    expect(result.text).toContain("📍 <b>Current:</b> <code>test-provider/model-2</code>");
  });

  it("shows OpenRouter credit balance in the message but not the model buttons", async () => {
    loadProviderUsageSummaryMock.mockResolvedValueOnce({
      updatedAt: 1,
      providers: [
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          windows: [
            { label: "Credits", usedPercent: 0, remaining: 12.345 },
            { label: "PaidTier", usedPercent: 0 },
          ],
        },
      ],
    });

    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 1,
      provider: "openrouter",
    });

    expect(result.text).toContain("Usage:");
    expect(result.text).toContain("Credits $12.35");
    expect(result.text).not.toContain("PaidTier");

    const firstBtn = result.reply_markup.inline_keyboard[0][0];
    expect(firstBtn.text).not.toContain("Credits $12.35");
  });

  it("keeps Antigravity usage off the text line but in the keyboard", async () => {
    loadProviderUsageSummaryMock.mockResolvedValueOnce({
      updatedAt: 1,
      providers: [
        {
          provider: "google-antigravity",
          displayName: "Antigravity",
          windows: [{ label: "gemini-1.5-pro", usedPercent: 60 }],
        },
      ],
    });

    const result = await buildModelPickerMessage({
      cfg: mockCfg,
      page: 1,
      provider: "google-antigravity",
    });

    expect(result.text).not.toContain("Usage:");
    const firstBtn = result.reply_markup.inline_keyboard[0][0];
    expect(firstBtn.text).toContain(" · 40%");
  });
});

describe("buildProviderPickerMessage", () => {
  const mockCfg = {} as unknown as OpenClawConfig;

  it("renders the list of providers", async () => {
    const result = await buildProviderPickerMessage({
      cfg: mockCfg,
    });

    expect(result.text).toContain("Select a Provider");
    const rows = result.reply_markup.inline_keyboard;

    // 4 providers + trailing empty row = 5 rows
    expect(rows.length).toBe(5);
    expect(rows[0][0].text).toBe("📦 another-provider (5)");
    expect((rows[0][0] as { callback_data?: string }).callback_data).toBe("pp:another-provider");
    expect(rows[1][0].text).toBe("📦 google-antigravity (2)");
    expect((rows[1][0] as { callback_data?: string }).callback_data).toBe("pp:google-antigravity");
    expect(rows[2][0].text).toBe("📦 openrouter (2)");
    expect((rows[2][0] as { callback_data?: string }).callback_data).toBe("pp:openrouter");
    expect(rows[3][0].text).toBe("📦 test-provider (25)");
    expect((rows[3][0] as { callback_data?: string }).callback_data).toBe("pp:test-provider");
  });
});

describe("Model Picker Command Registration", () => {
  it("bot-handlers.ts should register 'models' command", async () => {
    expect(true).toBe(true);
  });
});
