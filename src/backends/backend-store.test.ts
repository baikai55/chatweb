/** @vitest-environment happy-dom */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  exportBackends,
  getBackendReferences,
  importBackends,
  loadBackendState,
  subscribeBackends,
} from "@/backends/backend-store";
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

  it("只注册一个 storage 监听器", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const unsubscribeFirst = subscribeBackends(vi.fn());
    const unsubscribeSecond = subscribeBackends(vi.fn());

    loadBackendState();
    loadBackendState();

    expect(addEventListener.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
    unsubscribeFirst();
    unsubscribeSecond();
    addEventListener.mockRestore();
  });

  it("接收其它标签页的后端配置并刷新模块缓存", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBackends(listener);
    const backend = createBackend({
      id: "cross-tab",
      name: "跨标签页后端",
      baseURL: "https://cross-tab.example/v1",
    });
    const next = {
      version: 1,
      backends: [backend],
      activeBackendId: "missing",
    };

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:backends",
      newValue: JSON.stringify(next),
    }));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      activeBackendId: backend.id,
      backends: [expect.objectContaining({ id: backend.id })],
    }));
    expect(loadBackendState().activeBackendId).toBe(backend.id);
    unsubscribe();
  });

  it("其它标签页删除配置或写入坏 JSON 时回到空状态并通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBackends(listener);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:backends",
      newValue: null,
    }));
    expect(loadBackendState()).toEqual({ version: 1, backends: [], activeBackendId: null });

    window.dispatchEvent(new StorageEvent("storage", {
      key: "chatweb:backends",
      newValue: "{broken",
    }));
    expect(loadBackendState()).toEqual({ version: 1, backends: [], activeBackendId: null });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("忽略无关的 storage 键", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBackends(listener);
    const before = loadBackendState();

    window.dispatchEvent(new StorageEvent("storage", {
      key: "unrelated",
      newValue: JSON.stringify({ version: 1, backends: [] }),
    }));

    expect(listener).not.toHaveBeenCalled();
    expect(loadBackendState()).toBe(before);
    unsubscribe();
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
