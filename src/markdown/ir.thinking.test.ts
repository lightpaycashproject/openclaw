import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("Markdown IR thinking tags", () => {
  it("parses <think> tags into thought style spans", () => {
    const ir = markdownToIR("<think>Some internal thought</think>Final answer");
    expect(ir.text).toBe("Some internal thoughtFinal answer");
    const thoughtStyle = ir.styles.find((s) => s.style === "thought");
    expect(thoughtStyle).toBeDefined();
    expect(ir.text.slice(thoughtStyle!.start, thoughtStyle!.end)).toBe("Some internal thought");
  });

  it("handles variants like <thought> and <thinking>", () => {
    const variants = ["<thought>", "<thinking>", "<antthinking>"];
    for (const v of variants) {
      const close = v.replace("<", "</");
      const ir = markdownToIR(`${v}Deep thought${close}`);
      expect(ir.styles.some((s) => s.style === "thought")).toBe(true);
    }
  });

  it("handles nested or unclosed tags gracefully", () => {
    const ir = markdownToIR("<think>Unclosed thinking");
    // Should still have the thought style till the end
    expect(ir.styles.some((s) => s.style === "thought")).toBe(true);
  });
});
