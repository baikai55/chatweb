import { describe, expect, it } from "vitest";

import {
  STT_PROVIDER_TYPES,
  VOICE_PROTOCOLS,
  backendStateSchema,
  createBackend,
  customTTSRequestSchema,
  customTTSRouteSchema,
  sttProviderSchema,
} from "@/backends/types";

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
      sttProvider: {
        type: "backend-native",
        baseURL: "",
        apiKey: "",
        model: "",
      },
      voiceRouting: {
        stt: { backendId: "", model: "", protocol: "auto", routeId: "" },
        tts: { backendId: "", model: "", protocol: "auto", routeId: "" },
      },
      customTTSRoutes: [],
      webSearchModeOverrides: {},
    });
  });

  it("新建后端默认自动选择语音协议，也能保存 STT/TTS 的独立绑定", () => {
    expect(VOICE_PROTOCOLS).toEqual(["auto", "grok-native", "openai-audio"]);
    expect(createBackend({ name: "默认", baseURL: "example.com" }).voiceRouting).toEqual({
      stt: { backendId: "", model: "", protocol: "auto", routeId: "" },
      tts: { backendId: "", model: "", protocol: "auto", routeId: "" },
    });

    const backend = createBackend({
      name: "双语音供应商",
      baseURL: "example.com",
      voiceRouting: {
        stt: { backendId: "asr", model: "whisper-1", protocol: "openai-audio" },
        tts: { backendId: "speech", model: "tts-1", protocol: "auto" },
      },
    });
    expect(backend.voiceRouting).toEqual({
      stt: { backendId: "asr", model: "whisper-1", protocol: "openai-audio", routeId: "" },
      tts: { backendId: "speech", model: "tts-1", protocol: "auto", routeId: "" },
    });
  });

  it("能保存自定义 TTS 路由并让 TTS binding 引用路由 id", () => {
    const backend = createBackend({
      name: "MiMo TTS",
      baseURL: "newapi.example.com",
      voiceRouting: {
        stt: { backendId: "", model: "", protocol: "auto" },
        tts: {
          backendId: "newapi",
          model: "mimo-v2.5-tts",
          protocol: "openai-audio",
          routeId: "mimo-chat",
        },
      },
      customTTSRoutes: [{
        id: "mimo-chat",
        name: "MiMo 对话 TTS",
        path: "/chat/completions",
        method: "POST",
        query: {},
        body: {
          model: "$model",
          messages: [{ role: "assistant", content: "$text" }],
          audio: { voice: "$voice", format: "$format" },
        },
        audioUrlPaths: [],
        audioBase64Paths: ["choices.*.message.audio.data"],
        mimeType: "audio/mpeg",
        defaultVoice: "mimo_default",
      }],
    });

    expect(backend.voiceRouting.tts.routeId).toBe("mimo-chat");
    expect(backend.customTTSRoutes).toEqual([expect.objectContaining({
      id: "mimo-chat",
      audioBase64Paths: ["choices.*.message.audio.data"],
      defaultVoice: "mimo_default",
    })]);
  });

  it("自定义 TTS 路由为旧配置补响应字段默认值", () => {
    expect(customTTSRouteSchema.parse({
      id: "minimal",
      name: "最小路由",
      path: "/speech",
    })).toEqual({
      id: "minimal",
      name: "最小路由",
      path: "/speech",
      method: "POST",
      query: {},
      body: {},
      audioUrlPaths: [],
      audioBase64Paths: [],
      mimeType: "audio/mpeg",
      defaultVoice: "",
    });
  });

  it("TTS 请求格式编辑器只接受 path/method/query/body", () => {
    expect(customTTSRequestSchema.parse({
      path: "/chat/completions",
      method: "POST",
      body: { model: "$model", messages: [{ role: "assistant", content: "$text" }] },
    })).toEqual({
      path: "/chat/completions",
      method: "POST",
      query: {},
      body: { model: "$model", messages: [{ role: "assistant", content: "$text" }] },
    });

    expect(customTTSRequestSchema.safeParse({
      id: "internal-id",
      name: "内部名称",
      path: "/chat/completions",
      audioBase64Paths: ["data"],
    }).success).toBe(false);
  });

  it("新建后端默认不选择模型，也能保存明确选择", () => {
    expect(createBackend({ name: "默认", baseURL: "example.com" }).chatInputSTTModel).toBe("");
    expect(createBackend({
      name: "已选择",
      baseURL: "example.com",
      chatInputSTTModel: "whisper-large-v3",
    }).chatInputSTTModel).toBe("whisper-large-v3");
  });

  it("导出稳定的供应商类型，并为缺失字段补默认值", () => {
    expect(STT_PROVIDER_TYPES).toEqual(["backend-native", "openai-compatible"]);
    expect(sttProviderSchema.parse({})).toEqual({
      type: "backend-native",
      baseURL: "",
      apiKey: "",
      model: "",
    });
  });

  it("新建后端能保存独立 OpenAI-compatible 转写供应商", () => {
    const backend = createBackend({
      name: "独立转写",
      baseURL: "chat.example.com",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "asr.example.com",
        apiKey: "sk-asr",
        model: "custom-asr",
      },
    });

    expect(backend.sttProvider).toEqual({
      type: "openai-compatible",
      baseURL: "asr.example.com",
      apiKey: "sk-asr",
      model: "custom-asr",
    });
  });

  it("拒绝未知的转写供应商类型", () => {
    expect(sttProviderSchema.safeParse({ type: "cpa-audio" }).success).toBe(false);
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
