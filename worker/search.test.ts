import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./auth";
import worker from "./index";
import { assertSafeSearchUrl, clampSearchTimeout, normalizeSearchQuery, runWebSearch } from "./search";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runWebSearch", () => {
  it("只清理空白，不擅自改写模型给出的搜索词", () => {
    expect(normalizeSearchQuery("  香港   今天 天气  ")).toBe("香港 今天 天气");
  });

  it("auto 优先用与 OpenCode 相同的 Exa MCP 通用搜索", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response([
      "event: message",
      "data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: 香港天文台天气预报\\nURL: https://www.hko.gov.hk/sc/wxinfo/currwx/flw.htm\\nPublished: N/A\\nAuthor: N/A\\nHighlights:\\n香港今日天气、气温及降雨资料\"}]},\"jsonrpc\":\"2.0\",\"id\":1}",
      "",
    ].join("\n"), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({ query: "香港 今天 天气", provider: "auto" });

    expect(result).toMatchObject({
      ok: true,
      provider: "exa",
      items: [{
        title: "香港天文台天气预报",
        url: "https://www.hko.gov.hk/sc/wxinfo/currwx/flw.htm",
        source: "exa",
      }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: "香港 今天 天气" } },
    });
  });

  it("解析 Bing RSS 搜索结果", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <rss><channel><item>
        <title><![CDATA[测试 &amp; 标题]]></title>
        <description><![CDATA[<b>一段</b> 摘要]]></description>
        <link>https://example.com/a?x=1&amp;y=2</link>
      </item></channel></rss>
    `, { status: 200, headers: { "content-type": "application/rss+xml" } })));

    const result = await runWebSearch({ query: "  最新   消息 ", provider: "bing" });

    expect(result).toEqual({
      ok: true,
      query: "最新 消息",
      provider: "bing-rss",
      items: [{
        title: "测试 & 标题",
        snippet: "一段 摘要",
        url: "https://example.com/a?x=1&y=2",
        source: "bing-rss",
      }],
    });
  });

  it("auto 在 Exa 和 Bing 失败后回退到 SearXNG", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cn.bing.com/")) return new Response("", { status: 503 });
      if (url.startsWith("https://searx.be/search")) {
        return Response.json({
          results: [{ title: "SearX 结果", content: "搜索摘要", url: "https://example.com/result" }],
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({ query: "test", provider: "auto" });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("searxng");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("auto 不猜测结果语义，返回第一个有条目的搜索源", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cn.bing.com/")) {
        return new Response(`
          <rss><channel><item>
            <title>香港旅游攻略</title>
            <description>维基百科、景点和酒店介绍</description>
            <link>https://example.com/travel</link>
          </item></channel></rss>
        `, { status: 200, headers: { "content-type": "application/rss+xml" } });
      }
      if (url.startsWith("https://searx.be/search")) {
        return Response.json({
          results: [{
            title: "香港今日天气及气温",
            content: "香港降雨概率及天气警告",
            url: "https://www.hko.gov.hk/tc/wxinfo/currwx/current.htm",
          }],
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({ query: "香港 今天 天气 气温 降雨概率 天气预警", provider: "auto" });

    expect(result).toMatchObject({
      ok: true,
      query: "香港 今天 天气 气温 降雨概率 天气预警",
      provider: "bing-rss",
    });
    expect(result.items[0]?.url).toBe("https://example.com/travel");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]))).toContain("香港+今天+天气+气温+降雨概率+天气预警");
  });

  it("同一来源的重复条目去重，并保留搜索源返回顺序", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <rss><channel>
        <item>
          <title>香港旅游攻略</title>
          <description>景点和酒店介绍</description>
          <link>https://example.com/travel</link>
        </item>
        <item>
          <title>香港天气预报</title>
          <description>今日气温及降雨概率</description>
          <link>https://example.com/weather</link>
        </item>
        <item>
          <title>重复天气预报</title>
          <description>今日气温及降雨概率</description>
          <link>https://example.com/weather</link>
        </item>
      </channel></rss>
    `, { status: 200 })));

    const result = await runWebSearch({ query: "香港今天天气", provider: "bing-rss" });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.title).toBe("香港旅游攻略");
    expect(result.items[1]?.title).toBe("香港天气预报");
  });

  it("支持 DuckDuckGo、Tavily 和 Serper 的响应形状", async () => {
    const responses = [
      Response.json({ AbstractText: "Duck 摘要", Heading: "Duck", AbstractURL: "https://duckduckgo.com/Test" }),
      Response.json({ answer: "Tavily 摘要", results: [] }),
      Response.json({ organic: [{ title: "Serper", snippet: "Serper 摘要", link: "https://example.com/serper" }] }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift() ?? new Response("", { status: 500 })));

    const duck = await runWebSearch({ query: "duck", provider: "duckduckgo" });
    const tavily = await runWebSearch({ query: "tavily", provider: "tavily", apiKey: "tvly-test" });
    const serper = await runWebSearch({ query: "serper", provider: "serper", apiKey: "serper-test" });

    expect(duck.items[0]?.source).toBe("duckduckgo-abstract");
    expect(tavily.items[0]?.source).toBe("tavily-answer");
    expect(serper.items[0]?.source).toBe("serper");
  });

  it("上游异常不会把 API key 带进结果", async () => {
    const apiKey = "tvly-never-expose-this";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`request failed with ${apiKey}`);
    }));

    const result = await runWebSearch({ query: "test", provider: "tavily", apiKey });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("搜索服务请求失败");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("外部 AbortSignal 能取消搜索", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    )));

    const pending = runWebSearch({ query: "test", provider: "bing", signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: "搜索已取消" });
  });

  it("总超时会中止正在进行的请求", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    )));

    const pending = runWebSearch({ query: "test", provider: "bing", timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ ok: false, error: "搜索超时" });
  });

  it("拒绝超过字节上限的供应商响应", async () => {
    const oversized = new Uint8Array(1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized.subarray(0, 700_000));
        controller.enqueue(oversized.subarray(700_000));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));

    const result = await runWebSearch({ query: "test", provider: "duckduckgo" });

    expect(result).toMatchObject({ ok: false, error: "搜索服务响应太大" });
  });
});

describe("搜索地址安全校验", () => {
  it.each([
    "file:///etc/passwd",
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://2130706433",
    "http://10.1.2.3",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "https://user:pass@example.com",
  ])("拒绝 %s", (url) => {
    expect(() => assertSafeSearchUrl(url)).toThrow();
  });

  it("允许公网 HTTPS SearXNG 地址", () => {
    expect(assertSafeSearchUrl("https://search.example.org/searx")).toBe("https://search.example.org/searx");
  });

  it("不会跟随到私网地址的重定向", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({ query: "test", provider: "bing" });

    expect(result).toMatchObject({ ok: false, provider: "bing-rss" });
    expect(result.error).toContain("不能指向");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("不会让付费搜索密钥随重定向发往其他域名", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { location: "https://example.com/collect" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWebSearch({
      query: "test",
      provider: "tavily",
      apiKey: "tvly-secret",
    });

    expect(result).toMatchObject({ ok: false, provider: "tavily" });
    expect(result.error).toContain("不能携带密钥跨域重定向");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("将客户端超时严格限制在 1 到 15 秒", () => {
    expect(clampSearchTimeout(1)).toBe(1_000);
    expect(clampSearchTimeout(30_000)).toBe(15_000);
    expect(clampSearchTimeout(7_500.4)).toBe(7_500);
  });
});

describe("POST /__api/search", () => {
  const env = {
    ASSETS: { fetch: vi.fn() },
  } as unknown as Env;

  it("沿用现有同源鉴权并返回统一搜索结果", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      AbstractText: "route result",
      Heading: "Route",
      AbstractURL: "https://example.com/route",
    })));
    const request = new Request("https://chat.example/__api/search", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ query: "route", provider: "duckduckgo", timeoutMs: 99_999 }),
    });

    const response = await worker.fetch(request, env);
    const body = await response.json() as { ok: boolean; provider: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, provider: "duckduckgo" });
  });

  it("拒绝跨站调用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://chat.example/__api/search", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ query: "route" }),
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不相信 Content-Length，并按实际请求字节返回 413", async () => {
    const payload = JSON.stringify({ query: "x".repeat(17 * 1024) });
    const bytes = new TextEncoder().encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8 * 1024));
        controller.enqueue(bytes.subarray(8 * 1024));
        controller.close();
      },
    });
    const request = new Request("https://chat.example/__api/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "10",
        "sec-fetch-site": "same-origin",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    expect(request.headers.get("content-length")).toBe("10");
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(413);
  });
});
