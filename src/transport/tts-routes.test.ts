import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomTTSRoute } from "@/backends/types";
import { TransportError } from "@/transport/errors";
import {
  MIMO_CHAT_TTS_ROUTE,
  extractRoutedAudio,
  isRelativeTTSRoutePath,
  resolveTTSRoute,
  synthesizeWithTTSRoute,
  ttsRouteVariables,
} from "@/transport/tts-routes";

const BASE_URL = "https://api.example.test/v1";
const WAV_BASE64 = "UklGRgAAAAAAAAAAAAAA";
const MP3_BASE64 = "SUQzBAAAAAAAAAAAAAAA";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function route(patch: Partial<CustomTTSRoute> = {}): CustomTTSRoute {
  return {
    ...MIMO_CHAT_TTS_ROUTE,
    query: { ...MIMO_CHAT_TTS_ROUTE.query },
    body: structuredClone(MIMO_CHAT_TTS_ROUTE.body),
    audioUrlPaths: [...MIMO_CHAT_TTS_ROUTE.audioUrlPaths],
    audioBase64Paths: [...MIMO_CHAT_TTS_ROUTE.audioBase64Paths],
    ...patch,
  };
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function requestInit(mock: ReturnType<typeof vi.fn>): RequestInit {
  const init = mock.mock.calls[0]?.[1];
  if (!init || typeof init !== "object") throw new Error("fetch 没有收到 RequestInit");
  return init as RequestInit;
}

describe("resolveTTSRoute", () => {
  it("把 MiMo 模板展开为 assistant messages + audio，并补官方默认声线和 wav", () => {
    const resolved = resolveTTSRoute(BASE_URL, MIMO_CHAT_TTS_ROUTE, {
      model: "mimo-v2.5-tts",
      text: "  你好，小米。  ",
    });

    expect(resolved).toMatchObject({
      id: "mimo-chat-tts",
      url: `${BASE_URL}/chat/completions`,
      method: "POST",
      contentType: "audio/wav",
      audioBase64Paths: ["choices.*.message.audio.data", "audio.data", "data"],
    });
    expect(JSON.parse(resolved.body ?? "null")).toEqual({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: "你好，小米。" }],
      audio: { voice: "mimo_default", format: "wav" },
      stream: false,
    });
  });

  it("保留变量原类型、剪掉无值字段，并支持 path/query/mimeType 插值", () => {
    const custom = route({
      path: "/speech/${language}/synthesize",
      query: { model: "$model", speed: "$speed", omitted: "$unknown" },
      body: {
        model: "$model",
        input: "$text",
        voice: "$voice",
        speed: "$speed",
        language: "$language",
        nested: { missing: "$unknown" },
      },
      mimeType: "audio/${format}",
    });

    const resolved = resolveTTSRoute(BASE_URL, custom, {
      model: "tts/model",
      text: "hello",
      voice: "voice-a",
      format: "mp3",
      speed: 1.25,
      language: "en",
    });

    expect(resolved.url).toBe(`${BASE_URL}/speech/en/synthesize?model=tts%2Fmodel&speed=1.25`);
    expect(resolved.contentType).toBe("audio/mpeg");
    expect(JSON.parse(resolved.body ?? "null")).toEqual({
      model: "tts/model",
      input: "hello",
      voice: "voice-a",
      speed: 1.25,
      language: "en",
      nested: {},
    });
  });

  it("GET 路由不生成 body，且能列出实际使用的六种受支持变量", () => {
    const custom = route({
      method: "GET",
      path: "/speak/${model}",
      query: { q: "$text", voice: "$voice", ignored: "$vendor" },
      body: { speed: "$speed", language: "$language" },
      mimeType: "audio/${format}",
    });
    const resolved = resolveTTSRoute(BASE_URL, custom, {
      model: "tts-1",
      text: "hello",
      voice: "v1",
      speed: 1,
      language: "zh",
    });

    expect(resolved.body).toBeNull();
    expect([...ttsRouteVariables(custom)].sort()).toEqual([
      "format", "language", "model", "speed", "text", "voice",
    ]);
  });

  it("无效地址返回明确的路由错误", () => {
    expect(() => resolveTTSRoute("not a base url", route(), {
      model: "tts-1",
      text: "hello",
    })).toThrowError(TransportError);
    try {
      resolveTTSRoute("not a base url", route(), { model: "tts-1", text: "hello" });
    } catch (caught) {
      expect(caught).toMatchObject({ code: "invalid_route" });
    }
  });

  it("只接受所选供应商下的相对路径，拒绝完整 URL 和协议相对 URL", () => {
    expect(isRelativeTTSRoutePath("/chat/completions")).toBe(true);
    expect(isRelativeTTSRoutePath("audio/speech")).toBe(true);
    expect(isRelativeTTSRoutePath("https://speech.example.test/synthesize")).toBe(false);
    expect(isRelativeTTSRoutePath("//speech.example.test/synthesize")).toBe(false);

    for (const path of [
      "https://speech.example.test/synthesize",
      "//speech.example.test/synthesize",
    ]) {
      expect(() => resolveTTSRoute(BASE_URL, route({ path }), {
        model: "tts-1",
        text: "hello",
      })).toThrowError(/不能填写完整网址/);
    }
  });
});

describe("extractRoutedAudio", () => {
  it("用 * 展开 choices，并从 MiMo message.audio.data 提取 base64", () => {
    const result = extractRoutedAudio({
      choices: [
        { message: { content: "no audio" } },
        { message: { audio: { data: WAV_BASE64 } } },
      ],
    }, BASE_URL, {
      audioUrlPaths: [],
      audioBase64Paths: ["choices.*.message.audio.data"],
      contentType: "audio/wav",
    });

    expect(result).toEqual({
      url: `data:audio/wav;base64,${WAV_BASE64}`,
      contentType: "audio/wav",
      source: "base64",
    });
  });

  it("URL 路径支持相对地址，data URL 自带的音频类型优先", () => {
    expect(extractRoutedAudio({ output: { url: "/files/speech.mp3" } }, BASE_URL, {
      audioUrlPaths: ["output.url"],
      audioBase64Paths: [],
      contentType: "audio/mpeg",
    })).toEqual({
      url: "https://api.example.test/files/speech.mp3",
      contentType: "audio/mpeg",
      source: "url",
    });

    expect(extractRoutedAudio({ audio: `data:audio/mpeg;base64,${MP3_BASE64}` }, BASE_URL, {
      audioUrlPaths: [],
      audioBase64Paths: ["audio"],
      contentType: "audio/wav",
    })).toEqual({
      url: `data:audio/mpeg;base64,${MP3_BASE64}`,
      contentType: "audio/mpeg",
      source: "base64",
    });
  });

  it("兼容聚合层剥掉 choices/message 后的 audio.data", () => {
    expect(extractRoutedAudio({ audio: { data: WAV_BASE64 } }, BASE_URL, {
      audioUrlPaths: [],
      audioBase64Paths: MIMO_CHAT_TTS_ROUTE.audioBase64Paths,
      contentType: "audio/wav",
    })).toEqual({
      url: `data:audio/wav;base64,${WAV_BASE64}`,
      contentType: "audio/wav",
      source: "base64",
    });
  });

  it("拒绝脚本 URL 和不是 base64 的普通文本", () => {
    expect(extractRoutedAudio({ url: "javascript:alert(1)", data: "not audio bytes" }, BASE_URL, {
      audioUrlPaths: ["url"],
      audioBase64Paths: ["data"],
      contentType: "audio/wav",
    })).toBeNull();
  });
});

describe("synthesizeWithTTSRoute", () => {
  it("通过 Bearer 调用 MiMo Chat，并解析非流式 base64 响应", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({
      choices: [{ message: { audio: { data: WAV_BASE64 } } }],
    }), { headers: { "content-type": "application/json; charset=utf-8" } }));
    const controller = new AbortController();

    await expect(synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "sk-newapi",
      route: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "你好",
      signal: controller.signal,
    })).resolves.toEqual({
      url: `data:audio/wav;base64,${WAV_BASE64}`,
      contentType: "audio/wav",
      source: "base64",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/chat/completions`);
    const init = requestInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-newapi");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: "你好" }],
      audio: { voice: "mimo_default", format: "wav" },
      stream: false,
    });
  });

  it("显式选择 mp3 时同步替换请求 format 和 base64 MIME", async () => {
    stubFetch(new Response(JSON.stringify({
      choices: [{ message: { audio: { data: MP3_BASE64 } } }],
    }), { headers: { "content-type": "application/json" } }));

    const result = await synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "",
      route: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "hello",
      voice: "Mia",
      format: "mp3",
    });

    expect(result).toEqual({
      url: `data:audio/mpeg;base64,${MP3_BASE64}`,
      contentType: "audio/mpeg",
      source: "base64",
    });
    const init = requestInit(vi.mocked(fetch));
    expect(JSON.parse(String(init.body))).toMatchObject({ audio: { voice: "Mia", format: "mp3" } });
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("兼容自定义端点的二进制音频响应", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:custom-tts");
    stubFetch(new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { "content-type": "application/octet-stream" },
    }));

    await expect(synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "sk-test",
      route: route({ mimeType: "audio/wav" }),
      model: "tts-1",
      text: "hello",
    })).resolves.toEqual({
      url: "blob:custom-tts",
      contentType: "audio/wav",
      source: "binary",
    });
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("保留上游错误状态、代码和 request id", async () => {
    stubFetch(new Response(JSON.stringify({
      error: { message: "模型不支持该声线", code: "invalid_voice", request_id: "req-tts-1" },
    }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }));

    await expect(synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "sk-test",
      route: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "hello",
    })).rejects.toMatchObject({
      name: "TransportError",
      status: 422,
      code: "invalid_voice",
      requestId: "req-tts-1",
      message: "模型不支持该声线",
    });
  });

  it("取值路径未命中和浏览器直连失败时给出可定位错误", async () => {
    stubFetch(new Response(JSON.stringify({ choices: [{ message: { content: "missing audio" } }] }), {
      headers: { "content-type": "application/json" },
    }));
    await expect(synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "sk-test",
      route: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "hello",
    })).rejects.toMatchObject({ code: "invalid_response", message: expect.stringContaining("取值路径") });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(synthesizeWithTTSRoute({
      baseURL: BASE_URL,
      apiKey: "sk-test",
      route: MIMO_CHAT_TTS_ROUTE,
      model: "mimo-v2.5-tts",
      text: "hello",
    })).rejects.toMatchObject({ code: "network_error", message: expect.stringContaining("CORS") });
  });
});
