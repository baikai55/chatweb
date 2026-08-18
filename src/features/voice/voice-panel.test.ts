import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "@/backends/model-catalog";
import { createBackend, type Backend } from "@/backends/types";
import {
  defaultVoiceId,
  isVoiceConnectionReady,
  voiceModelCandidates,
  voiceProviderHistoryFields,
} from "@/features/voice/voice-panel";
import { resolveVoiceConnection } from "@/transport/voice-routing";
import { MIMO_CHAT_TTS_ROUTE } from "@/transport/tts-routes";

function makeBackend(id: string, patch: Partial<Backend> = {}): Backend {
  return createBackend({
    id,
    name: `供应商 ${id}`,
    baseURL: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    ...patch,
  });
}

function catalogModel(id: string, kind: CatalogModel["kind"], saved = true): CatalogModel {
  return {
    id,
    kind,
    saved,
    ownedBy: "test",
    overridden: false,
    reasoning: false,
    vendor: "测试",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VoicePanel 跨后端状态", () => {
  it("OpenAI Audio 默认 alloy，grok 原生默认 eve", () => {
    expect(defaultVoiceId("openai-audio")).toBe("alloy");
    expect(defaultVoiceId("grok-native")).toBe("eve");
    expect(defaultVoiceId("openai-audio", MIMO_CHAT_TTS_ROUTE)).toBe("mimo_default");
  });

  it("历史元数据记录实际 TTS 供应商，而不是顶部聊天后端", () => {
    const owner = makeBackend("chat");
    const speech = makeBackend("speech", { flavor: "generic" });
    owner.voiceRouting.tts = {
      backendId: speech.id,
      model: "gpt-4o-mini-tts",
      protocol: "openai-audio",
    };
    const connection = resolveVoiceConnection(owner, [owner, speech], "tts");

    expect(voiceProviderHistoryFields(connection, [owner, speech])).toEqual({
      providerBackendId: "speech",
      providerName: "供应商 speech",
      protocol: "openai-audio",
    });
  });

  it("旧配置的模型选择只读目标后端本地目录，不发起网络请求", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const owner = makeBackend("owner");
    const connection = resolveVoiceConnection(owner, [owner], "tts");
    const models = [
      catalogModel("tts-saved", "tts"),
      catalogModel("tts-unsaved", "tts", false),
      catalogModel("stt-saved", "stt"),
    ];

    expect(voiceModelCandidates(
      "tts",
      connection,
      owner,
      { [owner.id]: { models } },
      [],
    ).map((model) => model.id)).toEqual(["tts-saved"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("旧模型选择可以补齐 direct 后端，但不会绕过 proxy 不可用状态", () => {
    const direct = makeBackend("direct");
    const directConnection = resolveVoiceConnection(direct, [direct], "tts");
    expect(isVoiceConnectionReady(directConnection, "legacy-tts", [direct])).toBe(true);

    const proxy = makeBackend("proxy", { mode: "proxy" });
    const proxyConnection = resolveVoiceConnection(proxy, [proxy], "tts");
    expect(isVoiceConnectionReady(proxyConnection, "legacy-tts", [proxy])).toBe(false);
  });

  it("已在语音设置固定模型后，面板不再生成第二份模型选择", () => {
    const owner = makeBackend("owner", {
      voiceRouting: {
        stt: { backendId: "", model: "whisper-1", protocol: "openai-audio" },
        tts: { backendId: "", model: "tts-fixed", protocol: "openai-audio" },
      },
    });
    const connection = resolveVoiceConnection(owner, [owner], "tts");

    expect(voiceModelCandidates(
      "tts",
      connection,
      owner,
      { [owner.id]: { models: [catalogModel("tts-other", "tts")] } },
      [],
    )).toEqual([]);
  });
});
