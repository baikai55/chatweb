import { afterEach, describe, expect, it, vi } from "vitest";

import { requestWebSearch } from "@/transport/web-search";

afterEach(() => {
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

  it("把 AbortSignal 传给搜索请求", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ ok: false, query: "test", provider: "bing-rss", items: [], error: "没有结果" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await requestWebSearch({ query: "test", signal: controller.signal });
    expect(fetchMock).toHaveBeenCalledOnce();
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
