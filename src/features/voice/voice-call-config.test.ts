import { describe, expect, it } from "vitest";

import { createBackend, type Backend } from "@/backends/types";
import {
  buildConfiguredTTSOptions,
  buildVoiceCallTTSOptions,
  defaultVoiceCallVoice,
  resolveVoiceCallConfig,
} from "@/features/voice/voice-call-config";
import { MIMO_CHAT_TTS_ROUTE } from "@/transport/tts-routes";
import { resolveVoiceConnection, type VoiceConnection } from "@/transport/voice-routing";

function connection(patch: Partial<VoiceConnection> = {}): VoiceConnection {
  return {
    targetBackendId: "voice",
    baseURL: "https://voice.example/v1",
    apiKey: "voice-key",
    model: "voice-model",
    protocol: "grok-native",
    source: "binding",
    ready: true,
    reason: "",
    canListVoices: true,
    ...patch,
  };
}

function backend(id: string, patch: Partial<Backend> = {}): Backend {
  return createBackend({
    id,
    name: id,
    baseURL: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    ...patch,
  });
}

describe("resolveVoiceCallConfig", () => {
  it("聊天、STT 和 TTS 都已配置时允许启动", () => {
    const sttConnection = connection({ model: "whisper-1" });
    const ttsConnection = connection({ model: "tts-1" });

    expect(resolveVoiceCallConfig({
      chatModel: "  gpt-chat  ",
      sttConnection,
      ttsConnection,
    })).toEqual({
      chatModel: "gpt-chat",
      sttConnection,
      ttsConnection,
      ready: true,
      issues: [],
      reason: "",
    });
  });

  it("一次返回聊天、STT 和 TTS 的全部缺项", () => {
    const config = resolveVoiceCallConfig({
      chatModel: " ",
      sttConnection: connection({ ready: false, reason: "语音转写后端已不存在" }),
      ttsConnection: connection({ model: "" }),
    });

    expect(config.ready).toBe(false);
    expect(config.issues).toEqual([
      { requirement: "chat", message: "请先选择聊天模型" },
      { requirement: "stt", message: "语音转写后端已不存在" },
      { requirement: "tts", message: "请先选择语音合成模型" },
    ]);
    expect(config.reason).toBe("请先选择聊天模型；语音转写后端已不存在；请先选择语音合成模型");
  });

  it("跨后端连接保持各自的地址和 Key", () => {
    const stt = backend("stt");
    const tts = backend("tts", { customTTSRoutes: [MIMO_CHAT_TTS_ROUTE] });
    const chat = backend("chat", {
      voiceRouting: {
        stt: { backendId: stt.id, model: "whisper-1", protocol: "openai-audio" },
        tts: {
          backendId: tts.id,
          model: "mimo-v2.5-tts",
          protocol: "openai-audio",
          routeId: MIMO_CHAT_TTS_ROUTE.id,
        },
      },
    });
    const sttConnection = resolveVoiceConnection(chat, [chat, stt, tts], "stt");
    const ttsConnection = resolveVoiceConnection(chat, [chat, stt, tts], "tts");
    const config = resolveVoiceCallConfig({ chatModel: "gpt-chat", sttConnection, ttsConnection });

    expect(config.ready).toBe(true);
    expect(config.sttConnection).toMatchObject({
      targetBackendId: "stt",
      baseURL: "https://stt.example/v1",
      apiKey: "stt-key",
    });
    expect(config.ttsConnection).toMatchObject({
      targetBackendId: "tts",
      baseURL: "https://tts.example/v1",
      apiKey: "tts-key",
    });
    expect(buildVoiceCallTTSOptions(config.ttsConnection, "你好")).toMatchObject({
      baseURL: "https://tts.example/v1",
      apiKey: "tts-key",
      customRoute: MIMO_CHAT_TTS_ROUTE,
    });
    expect(buildVoiceCallTTSOptions(config.ttsConnection, "你好").apiKey).not.toBe(chat.apiKey);
  });
});

describe("通话 TTS 参数", () => {
  it("普通回复朗读不强制指定语言", () => {
    expect(buildConfiguredTTSOptions(connection(), "Hello")).not.toHaveProperty("language");
  });

  it("自定义路由声线优先，并使用中文和原连接参数", () => {
    const controller = new AbortController();
    const ttsConnection = connection({
      baseURL: "https://mimo.example/v1",
      apiKey: "mimo-key",
      model: "mimo-v2.5-tts",
      protocol: "openai-audio",
      ttsRoute: MIMO_CHAT_TTS_ROUTE,
    });

    expect(defaultVoiceCallVoice(ttsConnection)).toBe("mimo_default");
    expect(buildVoiceCallTTSOptions(ttsConnection, "  你好  ", controller.signal)).toEqual({
      baseURL: "https://mimo.example/v1",
      apiKey: "mimo-key",
      protocol: "openai-audio",
      customRoute: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "你好",
      voiceId: "mimo_default",
      language: "zh",
      speed: 1,
      signal: controller.signal,
    });
  });

  it("内置 OpenAI 和 Grok 协议分别使用 alloy 与 eve", () => {
    expect(defaultVoiceCallVoice(connection({ protocol: "openai-audio" }))).toBe("alloy");
    expect(defaultVoiceCallVoice(connection({ protocol: "grok-native" }))).toBe("eve");
  });

  it("未就绪或没有文字时拒绝构造请求", () => {
    expect(() => buildVoiceCallTTSOptions(
      connection({ ready: false, reason: "TTS 路由已失效" }),
      "你好",
    )).toThrow("TTS 路由已失效");
    expect(() => buildVoiceCallTTSOptions(connection(), " ")).toThrow("语音合成文字不能为空");
  });
});
