import { describe, expect, it } from "vitest";

import { createBackend, type Backend } from "@/backends/types";
import { MIMO_CHAT_TTS_ROUTE } from "@/transport/tts-routes";
import { resolveVoiceConnection } from "@/transport/voice-routing";

function makeBackend(id: string, patch: Partial<Backend> = {}): Backend {
  return createBackend({
    id,
    name: id,
    baseURL: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    ...patch,
  });
}

describe("resolveVoiceConnection", () => {
  it("新 STT binding 引用已有 grok2api 后端，并在 auto 下选择原生协议", () => {
    const grok = makeBackend("grok", { flavor: "grok2api" });
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: grok.id, model: "grok-stt", protocol: "auto" },
        tts: { backendId: "", model: "", protocol: "grok-native" },
      },
    });

    expect(resolveVoiceConnection(owner, [owner, grok], "stt")).toEqual({
      targetBackendId: "grok",
      baseURL: "https://grok.example/v1",
      apiKey: "grok-key",
      model: "grok-stt",
      protocol: "grok-native",
      source: "binding",
      ready: true,
      reason: "",
      canListVoices: true,
    });
  });

  it("新 TTS binding 的空 backendId 表示自身，generic auto 选择 OpenAI Audio", () => {
    const owner = makeBackend("owner", {
      flavor: "generic",
      voiceRouting: {
        stt: { backendId: "", model: "", protocol: "grok-native" },
        tts: { backendId: "", model: "tts-1", protocol: "auto" },
      },
    });

    expect(resolveVoiceConnection(owner, [owner], "tts")).toMatchObject({
      targetBackendId: "owner",
      model: "tts-1",
      protocol: "openai-audio",
      source: "binding",
      ready: true,
      reason: "",
      canListVoices: false,
    });
  });

  it("TTS binding 会从目标后端解析自定义路由", () => {
    const speech = makeBackend("speech", { customTTSRoutes: [MIMO_CHAT_TTS_ROUTE] });
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: "", model: "", protocol: "auto" },
        tts: {
          backendId: speech.id,
          model: "mimo-v2.5-tts",
          protocol: "openai-audio",
          routeId: MIMO_CHAT_TTS_ROUTE.id,
        },
      },
    });

    expect(resolveVoiceConnection(owner, [owner, speech], "tts")).toMatchObject({
      targetBackendId: "speech",
      model: "mimo-v2.5-tts",
      routeId: "mimo-chat-tts",
      ttsRoute: MIMO_CHAT_TTS_ROUTE,
      ready: true,
      canListVoices: false,
    });
  });

  it("自定义 TTS 路由被删除后明确阻止请求，不回退到 Audio Speech", () => {
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: "", model: "", protocol: "auto" },
        tts: {
          backendId: "",
          model: "mimo-v2.5-tts",
          protocol: "openai-audio",
          routeId: "deleted-route",
        },
      },
    });

    expect(resolveVoiceConnection(owner, [owner], "tts")).toMatchObject({
      routeId: "deleted-route",
      ready: false,
      reason: expect.stringContaining("已不存在"),
    });
  });

  it("引用的后端不存在时保留模型并返回明确的未就绪原因", () => {
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: "deleted", model: "whisper-1", protocol: "openai-audio" },
        tts: { backendId: "", model: "", protocol: "grok-native" },
      },
    });

    expect(resolveVoiceConnection(owner, [owner], "stt")).toMatchObject({
      targetBackendId: "deleted",
      baseURL: "",
      model: "whisper-1",
      protocol: "openai-audio",
      source: "binding",
      ready: false,
      reason: expect.stringContaining("不存在"),
    });
  });

  it("proxy 目标不会被误当成可直连后端", () => {
    const proxy = makeBackend("proxy", { mode: "proxy", apiKey: "" });
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: proxy.id, model: "whisper-1", protocol: "openai-audio" },
        tts: { backendId: "", model: "", protocol: "grok-native" },
      },
    });

    expect(resolveVoiceConnection(owner, [owner, proxy], "stt")).toMatchObject({
      targetBackendId: "proxy",
      ready: false,
      reason: expect.stringContaining("proxy"),
    });
  });

  it("旧独立 STT 按规范化地址和完整 Key 精确匹配已有后端", () => {
    const asr = makeBackend("asr", {
      baseURL: "https://asr.example/v1",
      apiKey: "same-key",
    });
    const owner = makeBackend("owner", {
      sttProvider: {
        type: "openai-compatible",
        baseURL: "asr.example/",
        apiKey: "same-key",
        model: "custom-asr",
      },
    });

    expect(resolveVoiceConnection(owner, [owner, asr], "stt")).toMatchObject({
      targetBackendId: "asr",
      baseURL: "https://asr.example/v1",
      apiKey: "same-key",
      model: "custom-asr",
      protocol: "openai-audio",
      source: "legacy-stt-provider",
      ready: true,
    });
  });

  it("旧独立 STT 找不到匹配后端时仍可直连旧地址", () => {
    const owner = makeBackend("owner", {
      sttProvider: {
        type: "openai-compatible",
        baseURL: "legacy-asr.example",
        apiKey: "legacy-key",
        model: "legacy-asr",
      },
    });

    expect(resolveVoiceConnection(owner, [owner], "stt")).toEqual({
      targetBackendId: "",
      baseURL: "https://legacy-asr.example/v1",
      apiKey: "legacy-key",
      model: "legacy-asr",
      protocol: "openai-audio",
      source: "legacy-stt-provider",
      ready: true,
      reason: "",
      canListVoices: false,
    });
  });

  it("旧原生 STT 回退聊天模型和当前后端的 /stt", () => {
    const owner = makeBackend("owner", { chatInputSTTModel: "grok-stt" });

    expect(resolveVoiceConnection(owner, [owner], "stt")).toMatchObject({
      targetBackendId: "owner",
      model: "grok-stt",
      protocol: "grok-native",
      source: "legacy-current-backend",
      ready: true,
      canListVoices: true,
    });
  });

  it("旧 TTS 回退当前后端，模型留空但允许调用方面板覆盖", () => {
    const owner = makeBackend("owner");

    expect(resolveVoiceConnection(owner, [owner], "tts")).toMatchObject({
      targetBackendId: "owner",
      model: "",
      protocol: "grok-native",
      source: "legacy-current-backend",
      ready: true,
      reason: "",
      canListVoices: true,
    });
  });
});
