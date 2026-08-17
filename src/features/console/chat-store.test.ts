import { describe, expect, it } from "vitest";

import { deriveSessionTitle, type ConversationMessage } from "@/features/console/chat-store";

function userMessage(content: ConversationMessage["content"]): ConversationMessage {
  return { id: "m_test", role: "user", content };
}

describe("deriveSessionTitle", () => {
  it("继续兼容旧的纯文本消息", () => {
    expect(deriveSessionTitle([userMessage("  你好   世界  ")])).toBe("你好 世界");
  });

  it("从多模态消息的文本片段取标题", () => {
    expect(deriveSessionTitle([userMessage([
      { type: "text", text: "请描述这张图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ])])).toBe("请描述这张图");
  });

  it("纯图片消息也有可识别的标题", () => {
    expect(deriveSessionTitle([userMessage([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
    ])])).toBe("图片 × 2");
  });
});
