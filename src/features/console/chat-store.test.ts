import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  deriveSessionTitle,
  loadSessions,
  saveSession,
  type ChatSession,
  type ConversationMessage,
} from "@/features/console/chat-store";

const idbMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  delete: vi.fn(),
  getByScope: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/shared/db/idb", () => ({
  STORE_SESSIONS: "sessions",
  idbClear: idbMocks.clear,
  idbDelete: idbMocks.delete,
  idbGetByScope: idbMocks.getByScope,
  idbPut: idbMocks.put,
}));

function userMessage(content: ConversationMessage["content"]): ConversationMessage {
  return { id: "m_test", role: "user", content };
}

function session(): ChatSession {
  return {
    id: "session",
    scope: "backend",
    title: "测试",
    createdAt: 1,
    updatedAt: 1,
    model: "model",
    reasoningEffort: "auto",
    webSearch: false,
    messages: [userMessage("测试")],
  };
}

beforeEach(() => {
  idbMocks.clear.mockReset().mockResolvedValue(undefined);
  idbMocks.delete.mockReset().mockResolvedValue(undefined);
  idbMocks.getByScope.mockReset().mockResolvedValue([]);
  idbMocks.put.mockReset().mockResolvedValue("session");
});

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

describe("聊天历史持久化失败", () => {
  it("读取失败会向调用方抛出，而不是伪装成空历史", async () => {
    const error = new Error("IndexedDB unavailable");
    idbMocks.getByScope.mockRejectedValueOnce(error);

    await expect(loadSessions("backend")).rejects.toBe(error);
  });

  it("保存失败返回带操作类型的可观察结果", async () => {
    const error = new Error("quota exceeded");
    idbMocks.put.mockRejectedValueOnce(error);

    await expect(saveSession(session())).resolves.toEqual({
      ok: false,
      operation: "save",
      error,
    });
  });

  it("删除失败也不会静默成功", async () => {
    const error = new Error("transaction aborted");
    idbMocks.delete.mockRejectedValueOnce(error);

    await expect(deleteSession("session")).resolves.toEqual({
      ok: false,
      operation: "delete",
      error,
    });
  });
});
