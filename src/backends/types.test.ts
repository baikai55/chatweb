import { describe, expect, it } from "vitest";

import { backendStateSchema, createBackend } from "@/backends/types";

describe("聊天语音输入模型的后端配置", () => {
  it("读取旧版后端配置时补为空字符串并保留旧字段", () => {
    const state = backendStateSchema.parse({
      version: 1,
      activeBackendId: "legacy",
      backends: [{
        id: "legacy",
        name: "旧后端",
        baseURL: "https://example.com/v1",
        apiKey: "old-key",
        savedModels: ["whisper-large-v3"],
      }],
    });

    expect(state.backends[0]).toMatchObject({
      id: "legacy",
      apiKey: "old-key",
      savedModels: ["whisper-large-v3"],
      chatInputSTTModel: "",
      webSearchModeOverrides: {},
    });
  });

  it("新建后端默认不选择模型，也能保存明确选择", () => {
    expect(createBackend({ name: "默认", baseURL: "example.com" }).chatInputSTTModel).toBe("");
    expect(createBackend({
      name: "已选择",
      baseURL: "example.com",
      chatInputSTTModel: "whisper-large-v3",
    }).chatInputSTTModel).toBe("whisper-large-v3");
  });
});

describe("模型联网方式的后端配置", () => {
  it("新建后端默认让所有模型自动选择联网方式", () => {
    expect(createBackend({ name: "默认", baseURL: "example.com" }).webSearchModeOverrides).toEqual({});
  });

  it("按模型保存原生和函数搜索选择", () => {
    const backend = createBackend({
      name: "搜索设置",
      baseURL: "example.com",
      webSearchModeOverrides: {
        "grok-4": "native",
        "deepseek-v4": "function",
      },
    });

    expect(backend.webSearchModeOverrides).toEqual({
      "grok-4": "native",
      "deepseek-v4": "function",
    });
  });

  it("拒绝未知的联网方式", () => {
    expect(backendStateSchema.safeParse({
      version: 1,
      activeBackendId: "invalid",
      backends: [{
        id: "invalid",
        name: "错误配置",
        baseURL: "https://example.com/v1",
        webSearchModeOverrides: { model: "browser" },
      }],
    }).success).toBe(false);
  });
});
