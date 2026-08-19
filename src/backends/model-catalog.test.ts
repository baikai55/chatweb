import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import { classifyModel, readFlavor, readModelCatalog, refreshModelCatalog } from "@/backends/model-catalog";
import { idbGet, idbPut } from "@/shared/db/idb";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

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
    vi.useRealTimers();
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

  it("模型目录建连超时会中止请求", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));

    const refreshing = refreshModelCatalog(backend);
    const assertion = expect(refreshing).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      message: expect.stringContaining("连接模型目录接口"),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("模型目录正文超时会中止请求", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => new Promise<unknown>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return Promise.resolve(response);
    }));

    const refreshing = refreshModelCatalog(backend);
    const assertion = expect(refreshing).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      message: expect.stringContaining("读取模型目录响应"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("外部取消模型元数据请求时保留 AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(input).endsWith("/v1/models") && !headers.has("Anthropic-Version")) {
        return Promise.resolve(Response.json({ data: [{ id: "tts-1", owned_by: "openai" }] }));
      }
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const refreshing = refreshModelCatalog(backend, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    controller.abort();

    await expect(refreshing).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
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
