import { afterEach, describe, expect, it, vi } from "vitest";

import { requestWebSearch } from "@/transport/web-search";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("requestWebSearch", () => {
  it("把函数参数发给同源 Worker，并过滤不可信的结果字段", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      ok: true,
      query: "test query",
      provider: "searxng",
      items: [
        { title: "结果", snippet: "摘要", url: "https://example.com/a", source: "searxng" },
        { title: "危险链接", snippet: "不会保留 URL", url: "javascript:alert(1)" },
        { ignored: true },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestWebSearch({
      query: "test query",
      provider: "searxng",
      apiKey: "",
      baseUrl: "https://search.example.com",
    });

    expect(result.items).toEqual([
      { title: "结果", snippet: "摘要", url: "https://example.com/a", source: "searxng" },
      { title: "危险链接", snippet: "不会保留 URL" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/__api/search", expect.objectContaining({ method: "POST" }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      query: "test query",
      provider: "searxng",
      baseUrl: "https://search.example.com",
    });
  });

  it("HTTP 错误优先使用 Worker 的安全错误文案", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "未授权" }, { status: 401 })));

    await expect(requestWebSearch({ query: "test" })).rejects.toThrow("设置的“联网”页验证访问口令");
  });

  it("外部取消搜索时保留 AbortError，并中止底层请求", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);

    const searching = requestWebSearch({ query: "test", signal: controller.signal });
    controller.abort();

    await expect(searching).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
    expect(requestSignal).toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("搜索响应正文超时会中止底层请求", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return Promise.resolve(response);
    }));

    const searching = requestWebSearch({ query: "test" });
    const assertion = expect(searching).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      message: expect.stringContaining("读取函数搜索响应"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("auto 不覆盖 Worker 的 SEARCH_PROVIDER 环境配置", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ query: "test" });
      return Response.json({ ok: false, query: "test", provider: "bing-rss", items: [], error: "没有结果" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestWebSearch({ query: "test", provider: "auto" });
  });
});
