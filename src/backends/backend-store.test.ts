import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { exportBackends, getBackendReferences, importBackends } from "@/backends/backend-store";
import { createBackend } from "@/backends/types";

describe("exportBackends", () => {
  const storage = new Map<string, string>();

  beforeAll(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("按 includeKeys 同时脱敏或保留后端与独立 STT 密钥", () => {
    const backend = createBackend({
      id: "voice-backend",
      name: "语音后端",
      baseURL: "https://chat.example.com/v1",
      apiKey: "chat-secret",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "https://stt.example.com/v1",
        apiKey: "stt-secret",
        model: "whisper-large-v3",
      },
    });
    importBackends(JSON.stringify({
      version: 1,
      backends: [backend],
      activeBackendId: backend.id,
    }), { replace: true });

    const redacted = JSON.parse(exportBackends({ includeKeys: false }));
    expect(redacted.backends[0]).toMatchObject({
      apiKey: "",
      sttProvider: {
        apiKey: "",
        baseURL: "https://stt.example.com/v1",
        model: "whisper-large-v3",
      },
    });

    const withKeys = JSON.parse(exportBackends({ includeKeys: true }));
    expect(withKeys.backends[0]).toMatchObject({
      apiKey: "chat-secret",
      sttProvider: { apiKey: "stt-secret" },
    });
  });

  it("导入导出时保留自定义 TTS 路由及 binding 的路由引用", () => {
    const backend = createBackend({
      id: "newapi",
      name: "New API",
      baseURL: "https://newapi.example/v1",
      voiceRouting: {
        stt: { backendId: "", model: "SenseVoiceSmall", protocol: "openai-audio" },
        tts: {
          backendId: "",
          model: "mimo-v2.5-tts",
          protocol: "openai-audio",
          routeId: "mimo-chat",
        },
      },
      customTTSRoutes: [{
        id: "mimo-chat",
        name: "MiMo Chat TTS",
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

    importBackends(JSON.stringify({
      version: 1,
      backends: [backend],
      activeBackendId: backend.id,
    }), { replace: true });

    const exported = JSON.parse(exportBackends({ includeKeys: false }));
    expect(exported.backends[0].voiceRouting.tts).toMatchObject({
      model: "mimo-v2.5-tts",
      routeId: "mimo-chat",
    });
    expect(exported.backends[0].customTTSRoutes).toEqual([expect.objectContaining({
      id: "mimo-chat",
      audioBase64Paths: ["choices.*.message.audio.data"],
      defaultVoice: "mimo_default",
    })]);
  });

  it("能找出引用待删除语音供应商的其它后端", () => {
    const speech = createBackend({
      id: "speech-provider",
      name: "语音供应商",
      baseURL: "https://speech.example.com/v1",
    });
    const chat = createBackend({
      id: "chat-provider",
      name: "聊天供应商",
      baseURL: "https://chat.example.com/v1",
      voiceRouting: {
        stt: { backendId: speech.id, model: "whisper-1", protocol: "openai-audio" },
        tts: { backendId: "", model: "", protocol: "auto" },
      },
    });
    importBackends(JSON.stringify({
      version: 1,
      backends: [chat, speech],
      activeBackendId: chat.id,
    }), { replace: true });

    expect(getBackendReferences(speech.id).map((backend) => backend.id)).toEqual([chat.id]);
    expect(getBackendReferences(chat.id)).toEqual([]);
  });
});
