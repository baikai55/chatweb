import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import { classifyModel, readFlavor, readModelCatalog, refreshModelCatalog } from "@/backends/model-catalog";
import { idbGet, idbPut } from "@/shared/db/idb";

vi.mock("@/shared/db/idb", () => ({
  STORE_MODEL_CACHE: "modelCache",
  idbGet: vi.fn(),
  idbPut: vi.fn(),
}));

const backend = createBackend({
  id: "voice-provider",
  name: "语音供应商",
  baseURL: "https://voice.example/v1",
  apiKey: "sk-voice",
});

describe("语音模型归类", () => {
  it("把硅基流动的两款 ASR 放进 STT 推荐分组", () => {
    expect(classifyModel("FunAudioLLM/SenseVoiceSmall")).toBe("stt");
    expect(classifyModel("TeleAI/TeleSpeechASR")).toBe("stt");
  });

  it("仍把小米 MiMo TTS 归为语音合成", () => {
    expect(classifyModel("mimo-v2.5-tts")).toBe("tts");
  });
});

describe("模型目录的手动获取边界", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("读取本地目录时不会发起任何网络请求", async () => {
    vi.mocked(idbGet).mockResolvedValue({
      backendId: backend.id,
      baseURL: backend.baseURL,
      fetchedAt: 123,
      flavor: "generic",
      rows: [{ id: "whisper-1", ownedBy: "openai" }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readModelCatalog(backend)).resolves.toMatchObject({
      fetchedAt: 123,
      models: [{ id: "whisper-1", kind: "stt" }],
    });
    expect(idbGet).toHaveBeenCalledWith("modelCache", backend.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("没有缓存时返回 null，也不会偷偷刷新", async () => {
    vi.mocked(idbGet).mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(readModelCatalog(backend)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("显式刷新会等待 IndexedDB 写入完成后才返回", async () => {
    let finishWrite: ((key: IDBValidKey) => void) | undefined;
    vi.mocked(idbPut).mockImplementation(() => new Promise((resolve) => {
      finishWrite = resolve;
    }));

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/v1/models") && !headers.has("Anthropic-Version")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: "tts-1", owned_by: "openai" }],
        }), { headers: { "content-type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [], models: [] }), {
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const refreshing = refreshModelCatalog(backend).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(idbPut).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    finishWrite?.(backend.id);
    await expect(refreshing).resolves.toMatchObject({
      models: [{ id: "tts-1", kind: "tts" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("后端方言识别", () => {
  it("不会把通用 X-Request-ID 误判为 grok2api", () => {
    expect(readFlavor(new Headers({ "X-Request-ID": "req_openai_123" }))).toBe("generic");
  });

  it("仍能通过 CPA 专用响应头识别 CPA", () => {
    expect(readFlavor(new Headers({ "X-CPA-Version": "1.2.3" }))).toBe("cpa");
  });
});
