import { describe, expect, it } from "vitest";

import { webSearchSupport } from "@/transport/chat-completions";

describe("webSearchSupport", () => {
  it("Gemini 和 Grok 可用", () => {
    expect(webSearchSupport("gemini-2.5-pro").supported).toBe(true);
    expect(webSearchSupport("grok-4").supported).toBe(true);
  });

  it("Claude 不可用，并说明要走 /v1/messages", () => {
    const result = webSearchSupport("claude-sonnet-4-5");
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("/v1/messages");
  });

  it("认不出的模型不可用，但仍然给出理由 —— 按钮要禁用而不是消失", () => {
    const result = webSearchSupport("some-random-model");
    expect(result.supported).toBe(false);
    expect(result.reason).not.toBe("");
  });

  it("没选模型时提示先选模型", () => {
    expect(webSearchSupport("").reason).toBe("先选一个模型");
  });
});
