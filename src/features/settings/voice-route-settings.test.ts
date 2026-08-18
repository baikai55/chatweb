import { describe, expect, it } from "vitest";

import type { CatalogModel } from "@/backends/model-catalog";
import { createBackend } from "@/backends/types";
import {
  groupVoiceRouteModels,
  initialVoiceRoute,
  nextTTSRouteId,
  voiceRouteDraftForBackend,
} from "@/features/settings/settings-view";
import { MIMO_CHAT_TTS_ROUTE } from "@/transport/tts-routes";

function model(id: string, kind: CatalogModel["kind"]): CatalogModel {
  return {
    id,
    kind,
    saved: false,
    ownedBy: "test",
    overridden: false,
    reasoning: false,
    vendor: "test",
  };
}

describe("语音供应商设置 helper", () => {
  it("切换供应商只生成本地草稿，并清空上一家的模型", () => {
    expect(voiceRouteDraftForBackend("speech-provider")).toEqual({
      backendId: "speech-provider",
      model: "",
      protocol: "auto",
      routeId: "",
    });
  });

  it("模型归类只影响推荐分组，其余模型仍全部可选", () => {
    const stt = model("whisper-large-v3", "stt");
    const chat = model("gpt-4.1", "chat");
    const hidden = model("custom-audio", "hidden");

    const groups = groupVoiceRouteModels([stt, chat, hidden], "stt");

    expect(groups.recommended.map((item) => item.id)).toEqual(["whisper-large-v3"]);
    expect(groups.others.map((item) => item.id)).toEqual(["gpt-4.1", "custom-audio"]);
  });

  it("新配置使用自动协议，旧版当前后端 STT 仍保持原生端点", () => {
    const fresh = createBackend({
      id: "current",
      name: "当前后端",
      baseURL: "https://chat.example.com/v1",
    });
    expect(initialVoiceRoute(fresh, [fresh], "tts")).toMatchObject({
      backendId: "current",
      model: "",
      protocol: "auto",
    });
    expect(initialVoiceRoute(fresh, [fresh], "stt").protocol).toBe("auto");

    const legacyNative = createBackend({
      ...fresh,
      chatInputSTTModel: "grok-stt",
    });
    expect(initialVoiceRoute(legacyNative, [legacyNative], "stt")).toMatchObject({
      backendId: "current",
      model: "grok-stt",
      protocol: "grok-native",
    });
  });

  it("旧版独立 STT 配置能匹配到已经添加的供应商", () => {
    const speech = createBackend({
      id: "speech",
      name: "语音供应商",
      baseURL: "https://speech.example.com/v1",
      apiKey: "same-key",
    });
    const owner = createBackend({
      id: "chat",
      name: "聊天供应商",
      baseURL: "https://chat.example.com/v1",
      sttProvider: {
        type: "openai-compatible",
        baseURL: "https://speech.example.com",
        apiKey: "same-key",
        model: "whisper-large-v3",
      },
    });

    expect(initialVoiceRoute(owner, [owner, speech], "stt")).toEqual({
      backendId: "speech",
      model: "whisper-large-v3",
      protocol: "openai-audio",
      routeId: "",
    });
  });

  it("恢复 TTS 配置时保留自定义路由，切换供应商时清空", () => {
    const speech = createBackend({
      id: "speech",
      name: "语音供应商",
      baseURL: "https://speech.example.com/v1",
      customTTSRoutes: [MIMO_CHAT_TTS_ROUTE],
    });
    const owner = createBackend({
      id: "chat",
      name: "聊天供应商",
      baseURL: "https://chat.example.com/v1",
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

    expect(initialVoiceRoute(owner, [owner, speech], "tts")).toEqual({
      backendId: "speech",
      model: "mimo-v2.5-tts",
      protocol: "openai-audio",
      routeId: "mimo-chat-tts",
    });
    expect(voiceRouteDraftForBackend(owner.id).routeId).toBe("");
  });

  it("重复创建 MiMo 模板时生成稳定且不冲突的 id", () => {
    expect(nextTTSRouteId([], "mimo-chat-tts")).toBe("mimo-chat-tts");
    expect(nextTTSRouteId([
      MIMO_CHAT_TTS_ROUTE,
      { ...MIMO_CHAT_TTS_ROUTE, id: "mimo-chat-tts-2" },
    ], "mimo-chat-tts")).toBe("mimo-chat-tts-3");
  });
});
