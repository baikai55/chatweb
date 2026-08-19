import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  deriveSessionTitle,
  loadSessions,
  mergeSessionMessages,
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
  it("过滤损坏记录，同时保留旧版纯文本和当前多模态会话", async () => {
    const oldTextSession = session();
    const multimodalSession: ChatSession = {
      ...session(),
      id: "multimodal",
      updatedAt: 2,
      messages: [userMessage([
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
      ])],
    };
    idbMocks.getByScope.mockResolvedValueOnce([
      oldTextSession,
      { ...session(), id: "missing-messages", messages: undefined },
      {
        ...session(),
        id: "broken-image",
        messages: [{ id: "broken", role: "user", content: [{ type: "image_url", image_url: {} }] }],
      },
      multimodalSession,
    ]);

    await expect(loadSessions("backend")).resolves.toEqual([multimodalSession, oldTextSession]);
  });

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

describe("流式回复合并", () => {
  it("保留请求期间修改的模型、推理和联网偏好", () => {
    const base = session();
    const latest: ChatSession = {
      ...base,
      model: "new-model",
      reasoningEffort: "high",
      webSearch: true,
      title: "最新标题",
    };
    const assistant: ConversationMessage = {
      id: "m_assistant",
      role: "assistant",
      content: "完成",
    };

    expect(mergeSessionMessages(base, latest, [...base.messages, assistant], 99)).toEqual({
      ...latest,
      messages: [...base.messages, assistant],
      updatedAt: 99,
    });
  });

  it("latest 已切到其它会话时不会串用它的偏好", () => {
    const base = session();
    const other = { ...base, id: "other", model: "other-model" };

    expect(mergeSessionMessages(base, other, base.messages, 99)).toEqual({
      ...base,
      updatedAt: 99,
    });
  });
});
