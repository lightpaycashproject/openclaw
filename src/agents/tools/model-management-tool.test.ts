import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createModelManagementTool } from "./model-management-tool.js";

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text as string;
}

vi.mock("../model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    { id: "gpt-4", name: "GPT-4", provider: "openai", contextWindow: 128000 },
    { id: "gpt-4o", name: "GPT-4O", provider: "openai", contextWindow: 128000, reasoning: true },
    {
      id: "claude-3.5-sonnet",
      name: "Claude 3.5 Sonnet",
      provider: "anthropic",
      contextWindow: 200000,
    },
    {
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      provider: "google",
      contextWindow: 1000000,
    },
    { id: "llama-3.3-70b", name: "Llama 3.3 70B", provider: "openrouter", contextWindow: 128000 },
  ]),
}));

const {
  loadConfig: loadConfigMock,
  writeConfigFile: writeConfigFileMock,
  clearConfigCache: clearConfigCacheMock,
} = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  clearConfigCache: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  get loadConfig() {
    return loadConfigMock;
  },
  get writeConfigFile() {
    return writeConfigFileMock;
  },
  get clearConfigCache() {
    return clearConfigCacheMock;
  },
}));

describe("model-management tool", () => {
  let tool: ReturnType<typeof createModelManagementTool>;

  const mockConfig: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4o",
          fallbacks: ["anthropic/claude-3.5-sonnet"],
        },
        models: {
          "openai/gpt-4o": {},
          "anthropic/claude-3.5-sonnet": {},
        },
      },
    },
  } as unknown as OpenClawConfig;

  beforeEach(() => {
    tool = createModelManagementTool();
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(mockConfig);
  });

  describe("list action", () => {
    it("returns current configured models", async () => {
      const result = await tool.execute("test-call", { action: "list" });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.primary).toBe("openai/gpt-4o");
      expect(parsed.fallbacks).toEqual(["anthropic/claude-3.5-sonnet"]);
      expect(parsed.allModels).toContain("openai/gpt-4o");
      expect(parsed.allModels).toContain("anthropic/claude-3.5-sonnet");
    });
  });

  describe("add action", () => {
    it("adds a model to the config", async () => {
      const result = await tool.execute("test-call", {
        action: "add",
        model: "google/gemini-2.0-flash",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("Added model");
      expect(parsed.message).toContain("google/gemini-2.0-flash");
    });

    it("adds to existing models without duplicates", async () => {
      const result = await tool.execute("test-call", {
        action: "add",
        model: "openai/gpt-4o",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
    });
  });

  describe("remove action", () => {
    it("removes a model from the config", async () => {
      const result = await tool.execute("test-call", {
        action: "remove",
        model: "anthropic/claude-3.5-sonnet",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("Removed model");
    });

    it("handles removing non-existent model gracefully", async () => {
      const result = await tool.execute("test-call", {
        action: "remove",
        model: "nonexistent/model",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
    });
  });

  describe("setPrimary action", () => {
    it("sets the primary model", async () => {
      const result = await tool.execute("test-call", {
        action: "setPrimary",
        model: "openai/gpt-4",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("openai/gpt-4");
      expect(parsed.message).toContain("hot swap");
    });
  });

  describe("setFallbacks action", () => {
    it("sets fallback models from comma-separated string", async () => {
      const result = await tool.execute("test-call", {
        action: "setFallbacks",
        models: "anthropic/claude-3.5-sonnet, google/gemini-2.0-flash, openrouter/llama-3.3-70b",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("anthropic/claude-3.5-sonnet");
      expect(parsed.message).toContain("google/gemini-2.0-flash");
    });

    it("handles single fallback model", async () => {
      const result = await tool.execute("test-call", {
        action: "setFallbacks",
        models: "openai/gpt-4",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.success).toBe(true);
    });
  });

  describe("listAvailable action", () => {
    it("lists all available models from catalog", async () => {
      const result = await tool.execute("test-call", {
        action: "listAvailable",
        limit: 10,
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.total).toBe(5);
      expect(parsed.shown).toBe(5);
      expect(parsed.byProvider).toHaveProperty("openai");
      expect(parsed.byProvider).toHaveProperty("anthropic");
      expect(parsed.byProvider).toHaveProperty("google");
      expect(parsed.byProvider).toHaveProperty("openrouter");
    });

    it("filters by provider", async () => {
      const result = await tool.execute("test-call", {
        action: "listAvailable",
        provider: "openai",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.total).toBe(2);
      expect(parsed.byProvider.openai).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      const result = await tool.execute("test-call", {
        action: "listAvailable",
        limit: 2,
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.shown).toBe(2);
    });
  });

  describe("search action", () => {
    it("searches models by query", async () => {
      const result = await tool.execute("test-call", {
        action: "search",
        query: "gpt",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.query).toBe("gpt");
      expect(parsed.total).toBe(2);
      expect(parsed.models[0].provider).toBe("openai");
    });

    it("filters by provider and searches", async () => {
      const result = await tool.execute("test-call", {
        action: "search",
        query: "claude",
        provider: "anthropic",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.total).toBe(1);
      expect(parsed.models[0].id).toBe("claude-3.5-sonnet");
    });

    it("returns empty for no matches", async () => {
      const result = await tool.execute("test-call", {
        action: "search",
        query: "nonexistent-model-xyz",
      });
      const parsed = JSON.parse(getTextContent(result));

      expect(parsed.total).toBe(0);
      expect(parsed.models).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("throws error for unknown action", async () => {
      await expect(tool.execute("test-call", { action: "invalid" })).rejects.toThrow(
        "Unknown action",
      );
    });

    it("throws error when model param missing for add action", async () => {
      await expect(tool.execute("test-call", { action: "add" })).rejects.toThrow("model");
    });

    it("throws error when query param missing for search action", async () => {
      await expect(tool.execute("test-call", { action: "search" })).rejects.toThrow("query");
    });
  });
});
