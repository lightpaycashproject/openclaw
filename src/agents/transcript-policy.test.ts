import { describe, expect, it } from "vitest";
import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  describe("Anthropic provider (direct)", () => {
    it("enables Claude-specific sanitizers for anthropic provider", () => {
      const policy = resolveTranscriptPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for anthropic-messages API", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "anthropic-messages",
        modelId: "claude-3-opus-20240229",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });
  });

  describe("Claude models via non-Anthropic providers", () => {
    it("enables Claude-specific sanitizers for github-copilot with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "github-copilot",
        modelId: "claude-sonnet-4",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for openrouter with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "anthropic/claude-3.5-sonnet",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for opencode with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "opencode",
        modelId: "claude-3-haiku-20240307",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for amazon-bedrock with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("handles case-insensitive Claude model detection", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "CLAUDE-3-OPUS",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });
  });

  describe("OpenAI short-circuit", () => {
    it("disables Claude-specific sanitizers for OpenAI provider even with Claude in modelId", () => {
      // Edge case: OpenAI provider should short-circuit regardless of modelId
      const policy = resolveTranscriptPolicy({
        provider: "openai",
        modelId: "gpt-4-claude-variant", // hypothetical edge case
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("disables Claude-specific sanitizers for openai-codex provider", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openai-codex",
        modelId: "codex-davinci",
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });
  });

  it("disables sanitizeToolCallIds for OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
  });
});
