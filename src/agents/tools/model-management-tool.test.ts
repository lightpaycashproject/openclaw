import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelManagementTool } from "./model-management-tool.js";

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
    {
      id: "glm-5",
      name: "Z.ai: GLM 5",
      provider: "openrouter",
      contextWindow: 202752,
      reasoning: true,
    },
    {
      id: "glm-4.5",
      name: "Z.ai: GLM 4.5",
      provider: "openrouter",
      contextWindow: 131072,
      reasoning: true,
    },
  ]),
}));

describe("model-management tool", () => {
  let tool: ReturnType<typeof createModelManagementTool>;

  const mockContext = {
    config: {
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
    },
    workspaceDir: "/test/workspace",
  };

  beforeEach(() => {
    tool = createModelManagementTool();
    vi.clearAllMocks();
  });

  describe("resolveModelRef (implicit via add action)", () => {
    it("auto-prefixes model ID with provider from catalog", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "add", model: "glm-5" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("openrouter/glm-5");
      expect(parsed.message).toContain("openrouter/glm-5");
    });

    it("keeps existing provider prefix if already present", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "add", model: "openai/gpt-4" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("openai/gpt-4");
    });

    it("defaults to openrouter if model not found in catalog", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "add", model: "unknown-model-xyz" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("openrouter/unknown-model-xyz");
    });
  });

  describe("add action", () => {
    it("adds a model with auto-prefixed provider", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "add", model: "gpt-4" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("openai/gpt-4");
      expect(parsed.config).toBeDefined();
    });

    it("adds model with full provider prefix directly", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "add", model: "anthropic/claude-3.5-sonnet" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("anthropic/claude-3.5-sonnet");
    });
  });

  describe("remove action", () => {
    it("removes a model with auto-prefixed provider", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "remove", model: "claude-3.5-sonnet" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("anthropic/claude-3.5-sonnet");
    });
  });

  describe("setPrimary action", () => {
    it("sets primary model with auto-prefix", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "setPrimary", model: "glm-5" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.model).toBe("openrouter/glm-5");
      expect(parsed.message).toContain("hot swap");
    });
  });

  describe("setFallbacks action", () => {
    it("sets multiple fallback models with auto-prefix", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "setFallbacks", models: "glm-5, glm-4.5, gpt-4" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.models).toContain("openrouter/glm-5");
      expect(parsed.models).toContain("openrouter/glm-4.5");
      expect(parsed.models).toContain("openai/gpt-4");
    });

    it("handles single fallback model", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "setFallbacks", models: "glm-5" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.models).toContain("openrouter/glm-5");
    });
  });

  describe("list action", () => {
    it("returns current configured models", async () => {
      const result = await tool.execute("test-call", { action: "list" }, mockContext as unknown);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.primary).toBe("openai/gpt-4o");
      expect(parsed.fallbacks).toEqual(["anthropic/claude-3.5-sonnet"]);
      expect(parsed.allModels).toContain("openai/gpt-4o");
      expect(parsed.allModels).toContain("anthropic/claude-3.5-sonnet");
    });
  });

  describe("listAvailable action", () => {
    it("lists all available models from catalog", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "listAvailable", limit: 10 },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(7);
      expect(parsed.shown).toBe(7);
      expect(parsed.byProvider).toHaveProperty("openai");
      expect(parsed.byProvider).toHaveProperty("anthropic");
      expect(parsed.byProvider).toHaveProperty("google");
      expect(parsed.byProvider).toHaveProperty("openrouter");
    });

    it("filters by provider", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "listAvailable", provider: "openai" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(2);
      expect(parsed.byProvider.openai).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "listAvailable", limit: 2 },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.shown).toBe(2);
    });
  });

  describe("search action", () => {
    it("searches models by query", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "search", query: "gpt" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.query).toBe("gpt");
      expect(parsed.total).toBe(2);
      expect(parsed.models[0].provider).toBe("openai");
    });

    it("filters by provider and searches", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "search", query: "claude", provider: "anthropic" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(1);
      expect(parsed.models[0].id).toBe("claude-3.5-sonnet");
    });

    it("returns empty for no matches", async () => {
      const result = await tool.execute(
        "test-call",
        { action: "search", query: "nonexistent-model-xyz" },
        mockContext as unknown,
      );
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.total).toBe(0);
      expect(parsed.models).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("throws error for unknown action", async () => {
      await expect(
        tool.execute("test-call", { action: "invalid" }, mockContext as unknown),
      ).rejects.toThrow("Unknown action");
    });

    it("throws error when model param missing for add action", async () => {
      await expect(
        tool.execute("test-call", { action: "add" }, mockContext as unknown),
      ).rejects.toThrow("model");
    });

    it("throws error when query param missing for search action", async () => {
      await expect(
        tool.execute("test-call", { action: "search" }, mockContext as unknown),
      ).rejects.toThrow("query");
    });

    it("throws error when models param missing for setFallbacks action", async () => {
      await expect(
        tool.execute("test-call", { action: "setFallbacks" }, mockContext as unknown),
      ).rejects.toThrow("models");
    });
  });
});
