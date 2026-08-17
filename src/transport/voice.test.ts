import { afterEach, describe, expect, it, vi } from "vitest";

import { TransportError } from "@/transport/errors";
import {
  listVoices,
  releaseSpeechAudio,
  synthesizeSpeech,
  transcribeSpeech,
} from "@/transport/voice";
import type {
  ListVoicesOptions,
  SynthesizeSpeechOptions,
  TranscribeSpeechOptions,
} from "@/transport/voice";

const BASE_URL = "https://api.example.test/v1";

function listOptions(patch: Partial<ListVoicesOptions> = {}): ListVoicesOptions {
  return {
    baseURL: BASE_URL,
    apiKey: "sk-test",
    ...patch,
  };
}

function ttsOptions(patch: Partial<SynthesizeSpeechOptions> = {}): SynthesizeSpeechOptions {
  return {
    baseURL: BASE_URL,
    apiKey: "sk-test",
    model: "grok-tts",
    text: "你好，世界",
    voiceId: "zh-female-1",
    language: "zh-CN",
    ...patch,
  };
}

function sttOptions(patch: Partial<TranscribeSpeechOptions> = {}): TranscribeSpeechOptions {
  return {
    baseURL: BASE_URL,
    apiKey: "sk-test",
    model: "grok-stt",
    file: new File([new Uint8Array([82, 73, 70, 70])], "sample.wav", { type: "audio/wav" }),
    ...patch,
  };
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const init = fetchMock.mock.calls[0]?.[1];
  if (!init || typeof init !== "object") throw new Error("测试没有捕获到 fetch RequestInit");
  return init as RequestInit;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("listVoices", () => {
  it("发送模型、鉴权和 signal，并兼容嵌套列表、字符串声线及去重", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(new Response(JSON.stringify({
      data: {
        voices: [
          "alloy",
          {
            voice_id: "xiaoxiao",
            display_name: "晓晓",
            languages: ["zh-CN", "en-US"],
            preview_text: "温暖女声",
          },
          { id: "alloy", name: "重复项" },
          { name: "缺少 id" },
        ],
      },
    }), { headers: { "content-type": "application/json" } }));

    await expect(listVoices(listOptions({ model: "tts model/1", signal: controller.signal })))
      .resolves.toEqual([
        { voiceId: "alloy", name: "alloy" },
        {
          voiceId: "xiaoxiao",
          name: "晓晓",
          language: "zh-CN, en-US",
          description: "温暖女声",
        },
      ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/tts/voices?model=tts%20model%2F1`);
    const init = requestInit(fetchMock);
    expect(init.method).toBe("GET");
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("无法识别的成功响应会给出明确错误", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(listVoices(listOptions())).rejects.toMatchObject({
      name: "TransportError",
      status: 200,
      code: "invalid_response",
    });
  });
});

describe("synthesizeSpeech", () => {
  it("按 grok2api 形状发送完整 TTS 请求体", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(new Response(JSON.stringify({
      url: "https://cdn.example.test/speech.ogg",
      content_type: "audio/opus",
    }), { headers: { "content-type": "application/json; charset=utf-8" } }));

    await expect(synthesizeSpeech(ttsOptions({
      speed: 1.25,
      outputFormat: "opus",
      withTimestamps: true,
      signal: controller.signal,
    }))).resolves.toEqual({
      url: "https://cdn.example.test/speech.ogg",
      contentType: "audio/ogg",
      source: "url",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/tts`);
    const init = requestInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
    expect(new Headers(init.headers).get("accept")).toBe("application/json, audio/*, application/octet-stream");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "grok-tts",
      text: "你好，世界",
      voice_id: "zh-female-1",
      language: "zh-CN",
      speed: 1.25,
      output_format: { codec: "opus" },
      with_timestamps: true,
    });
  });

  it("读取二进制音频，并把 audio/opus 规范为浏览器可播放的 audio/ogg", async () => {
    const bytes = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);
    stubFetch(new Response(bytes, { headers: { "content-type": "audio/opus; codecs=opus" } }));
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:voice-test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const result = await synthesizeSpeech(ttsOptions({ outputFormat: "opus" }));

    expect(result).toEqual({
      url: "blob:voice-test",
      contentType: "audio/ogg",
      source: "binary",
    });
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error("TTS 二进制响应没有创建 Blob");
    expect(blob.type).toBe("audio/ogg");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(bytes));

    releaseSpeechAudio(result);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-test");
  });

  it("application/octet-stream 不覆盖请求指定的 codec", async () => {
    stubFetch(new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { "content-type": "application/octet-stream" },
    }));
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:wav-test");

    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "wav" }))).resolves.toEqual({
      url: "blob:wav-test",
      contentType: "audio/wav",
      source: "binary",
    });
    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) throw new Error("TTS 二进制响应没有创建 Blob");
    expect(blob.type).toBe("audio/wav");
  });

  it("application/ogg 二进制会规范为 audio/ogg", async () => {
    stubFetch(new Response(new Uint8Array([79, 103, 103, 83]), {
      headers: { "content-type": "application/ogg" },
    }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ogg-test");

    await expect(synthesizeSpeech(ttsOptions())).resolves.toEqual({
      url: "blob:ogg-test",
      contentType: "audio/ogg",
      source: "binary",
    });
  });

  it("JSON URL 字段支持无扩展名相对地址，不会误判成 base64", async () => {
    stubFetch(new Response(JSON.stringify({
      url: "audio/session-token-1234567890",
      duration_seconds: "2.75",
      content_type: "application/octet-stream",
    }), { headers: { "content-type": "application/json" } }));

    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "opus" }))).resolves.toEqual({
      url: `${BASE_URL}/audio/session-token-1234567890`,
      contentType: "audio/ogg",
      duration: 2.75,
      source: "url",
    });
  });

  it("JSON 内的裸 base64 会补齐 data URL，并沿用指定 codec", async () => {
    const audio = "T2dnUwAAAAAAAAAA";
    stubFetch(new Response(JSON.stringify({ audio_base64: audio, duration: 1.5 }), {
      headers: { "content-type": "application/json" },
    }));

    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "opus" }))).resolves.toEqual({
      url: `data:audio/ogg;base64,${audio}`,
      contentType: "audio/ogg",
      duration: 1.5,
      source: "base64",
    });
  });

  it("以 //u 开头的 MP3 base64 不会被误判为根相对 URL", async () => {
    const audio = "//uQAAAAAAAAAAAA";
    stubFetch(new Response(JSON.stringify({ audio_base64: audio }), {
      headers: { "content-type": "application/json" },
    }));

    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "mp3" }))).resolves.toEqual({
      url: `data:audio/mpeg;base64,${audio}`,
      contentType: "audio/mpeg",
      source: "base64",
    });
  });

  it("data URL 的 opus/octet-stream MIME 也会规范化或回退到请求 codec", async () => {
    stubFetch(new Response(JSON.stringify({ audio: "data:audio/opus;base64,T2dnUwAAAAAAAAAA" }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeSpeech(ttsOptions())).resolves.toMatchObject({
      url: "data:audio/ogg;base64,T2dnUwAAAAAAAAAA",
      contentType: "audio/ogg",
    });

    stubFetch(new Response(JSON.stringify({ audio: "data:application/octet-stream;base64,UklGRgAAAAAAAAAA" }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "wav" }))).resolves.toMatchObject({
      url: "data:audio/wav;base64,UklGRgAAAAAAAAAA",
      contentType: "audio/wav",
    });
  });

  it("文本响应里的根相对 URL 也优先按地址解析", async () => {
    stubFetch(new Response("/generated/audio/abcdefghijklmnop", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));

    await expect(synthesizeSpeech(ttsOptions({ outputFormat: "mp3" }))).resolves.toEqual({
      url: "https://api.example.test/generated/audio/abcdefghijklmnop",
      contentType: "audio/mpeg",
      source: "url",
    });
  });

  it("空二进制和无音频 JSON 分别返回可区分的传输错误", async () => {
    stubFetch(new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } }));
    await expect(synthesizeSpeech(ttsOptions())).rejects.toMatchObject({
      name: "TransportError",
      code: "empty_response",
    });

    stubFetch(new Response(JSON.stringify({ duration: 1 }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeSpeech(ttsOptions())).rejects.toMatchObject({
      name: "TransportError",
      code: "invalid_response",
    });
  });

  it("URL 字段拒绝脚本 scheme 和带空白的伪地址", async () => {
    stubFetch(new Response(JSON.stringify({ url: "javascript:alert(1)" }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeSpeech(ttsOptions())).rejects.toMatchObject({ code: "invalid_response" });

    stubFetch(new Response(JSON.stringify({ url: "audio path without encoding" }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeSpeech(ttsOptions())).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("上游错误体保留状态、代码和 request id", async () => {
    stubFetch(new Response(JSON.stringify({
      error: { message: "voice 不存在", code: "invalid_voice", request_id: "req-voice-1" },
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));

    const promise = synthesizeSpeech(ttsOptions());
    await expect(promise).rejects.toBeInstanceOf(TransportError);
    await expect(promise).rejects.toMatchObject({
      status: 422,
      code: "invalid_voice",
      requestId: "req-voice-1",
      message: "voice 不存在",
    });
  });
});

describe("transcribeSpeech", () => {
  it("自动识别语言时只上传 model 和 file，并接受纯文本响应", async () => {
    const controller = new AbortController();
    const options = sttOptions({ signal: controller.signal });
    const fetchMock = stubFetch(new Response("  今天天气很好。  ", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));

    await expect(transcribeSpeech(options)).resolves.toEqual({ text: "今天天气很好。" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/stt`);
    const init = requestInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("accept")).toBe("application/json, text/plain");

    const form = init.body as FormData;
    expect(form.get("model")).toBe("grok-stt");
    expect(form.has("language")).toBe(false);
    expect(form.has("format")).toBe(false);
    const uploaded = form.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe("sample.wav");
    expect((uploaded as File).type).toBe("audio/wav");
    expect((uploaded as File).size).toBe(4);
    expect(Array.from(new Uint8Array(await (uploaded as File).arrayBuffer()))).toEqual([82, 73, 70, 70]);
    expect(Array.from(form.keys())).toEqual(["model", "file"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("指定语言时同时发送 language/format，并解析 JSON words", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({
      text: "你好世界",
      language: "zh",
      duration_seconds: "1.8",
      words: [
        { word: "你好", start_time: "0.1", end_time: 0.7, speaker: 1 },
        { text: "世界", start: 0.8, end: "1.7", speaker: "A" },
        { start: 0, end: 1 },
      ],
    }), { headers: { "content-type": "application/json" } }));

    await expect(transcribeSpeech(sttOptions({ language: "zh-CN" }))).resolves.toEqual({
      text: "你好世界",
      language: "zh",
      duration: 1.8,
      words: [
        { text: "你好", start: 0.1, end: 0.7, speaker: 1 },
        { text: "世界", start: 0.8, end: 1.7, speaker: "A" },
      ],
    });

    const form = requestInit(fetchMock).body as FormData;
    expect(form.get("model")).toBe("grok-stt");
    expect(form.get("language")).toBe("zh-CN");
    expect(form.get("format")).toBe("true");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(Array.from(form.keys())).toEqual(["model", "language", "format", "file"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("支持 data 包裹的文本、语言、时长和 words", async () => {
    stubFetch(new Response(JSON.stringify({
      data: {
        transcript: "nested result",
        lang: "en",
        duration: 0.5,
        words: [{ text: "nested", start: 0, end: 0.25 }],
      },
    }), { headers: { "content-type": "application/json" } }));

    await expect(transcribeSpeech(sttOptions())).resolves.toEqual({
      text: "nested result",
      language: "en",
      duration: 0.5,
      words: [{ text: "nested", start: 0, end: 0.25, speaker: undefined }],
    });
  });

  it("空响应和无法识别的 JSON 都返回明确错误", async () => {
    stubFetch(new Response("", { status: 200 }));
    await expect(transcribeSpeech(sttOptions())).rejects.toMatchObject({
      name: "TransportError",
      code: "empty_response",
    });

    stubFetch(new Response(JSON.stringify({ words: [] }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(transcribeSpeech(sttOptions())).rejects.toMatchObject({
      name: "TransportError",
      code: "invalid_response",
    });
  });
});

describe("取消请求", () => {
  it("把 AbortSignal 交给 fetch，取消异常原样向上传递", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const rejectAbort = () => reject(signal.reason ?? new DOMException("已取消", "AbortError"));
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = listVoices(listOptions({ signal: controller.signal }));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(requestInit(fetchMock).signal).toBe(controller.signal);
  });
});
