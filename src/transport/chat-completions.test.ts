import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRequestBody, resolveWebSearchMode, streamChatCompletions, webSearchNote } from "@/transport/chat-completions";
import type { ChatCompletionsOptions } from "@/transport/chat-completions";
import { readChatContentText } from "@/transport/types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(message: Record<string, unknown>): Response {
  return Response.json({ choices: [{ message }] });
}

function options(patch: Partial<ChatCompletionsOptions> = {}): ChatCompletionsOptions {
  return {
    baseURL: "https://example.com/v1",
    apiKey: "sk-test",
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "auto",
    webSearch: false,
    ...patch,
  };
}

describe("webSearchNote", () => {
  it("认得出的模型说清会发什么形状", () => {
    expect(webSearchNote("gemini-2.5-pro")).toMatchObject({ known: true });
    expect(webSearchNote("grok-4")).toMatchObject({ known: true });
  });

  it("auto 只让已验证的 Gemini/Grok 走原生搜索", () => {
    expect(resolveWebSearchMode("gemini-2.5-pro")).toBe("native");
    expect(resolveWebSearchMode("grok-4")).toBe("native");
    expect(resolveWebSearchMode("DeepSeek-V4-Flash-0731")).toBe("function");
    expect(resolveWebSearchMode("claude-sonnet-4-5")).toBe("function");
  });

  it("手动模式覆盖自动判断", () => {
    expect(resolveWebSearchMode("deepseek-chat", "native")).toBe("native");
    expect(resolveWebSearchMode("grok-4", "function")).toBe("function");
  });

  it("认不出的模型也给一句话 —— 它只是提示，不决定按钮能不能点", () => {
    expect(webSearchNote("some-random-model").note).not.toBe("");
  });

  it("没选模型时提示先选模型", () => {
    expect(webSearchNote("").note).toBe("先选一个模型");
  });
});

describe("buildRequestBody 的联网搜索工具", () => {
  it("开关关着时一个 tools 字段都不加", () => {
    expect(buildRequestBody(options(), "generic")).not.toHaveProperty("tools");
  });

  it("Gemini 用原生 google_search 形状", () => {
    const body = buildRequestBody(options({ model: "gemini-2.5-pro", webSearch: true }), "cpa");
    expect(body.tools).toEqual([{ google_search: {} }]);
  });

  it("DeepSeek 和未知模型自动走标准 function schema", () => {
    const body = buildRequestBody(options({ model: "deepseek-chat", webSearch: true }), "generic");
    expect(body.tools).toEqual([expect.objectContaining({
      type: "function",
      function: expect.objectContaining({ name: "web_search" }),
    })]);
    expect(body.tool_choice).toBe("auto");
  });

  it("手动原生时仍然照发 web_search，让上游明确决定是否支持", () => {
    const body = buildRequestBody(options({
      model: "deepseek-chat",
      webSearch: true,
      webSearchMode: "native",
    }), "generic");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("Grok 手动切函数时不再发原生工具", () => {
    const body = buildRequestBody(options({ model: "grok-4", webSearch: true, webSearchMode: "function" }), "generic");
    expect(body.tools).toEqual([expect.objectContaining({ type: "function" })]);
  });
});

describe("buildRequestBody 的视觉消息", () => {
  it("保留 OpenAI image_url 内容数组，并兼容旧字符串消息", () => {
    const image = {
      type: "image_url" as const,
      image_url: { url: "data:image/png;base64,AAAA", detail: "high" as const },
    };
    const body = buildRequestBody(options({
      messages: [
        { role: "user", content: [{ type: "text", text: "这是什么？" }, image] },
        { role: "assistant", content: "上一条回答" },
      ],
    }), "generic");

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "这是什么？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
        ],
      },
      { role: "assistant", content: "上一条回答" },
    ]);
  });

  it("非流式视觉响应里的 text part 可以正常取回", () => {
    expect(readChatContentText([
      { type: "text", text: "先说结论：" },
      { type: "image_url", image_url: { url: "https://example.com/reference.png" } },
      { type: "text", text: "这是一只猫。" },
    ])).toBe("先说结论：这是一只猫。");
  });

  it("后端不走流式时也能读取 text part 数组", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: [{ type: "text", text: "我看到了图片。" }] } }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await streamChatCompletions(options({
        messages: [{
          role: "user",
          content: [{ type: "text", text: "描述这张图" }, {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          }],
        }],
      }));
      expect(result.text).toBe("我看到了图片。");
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(request?.body)).messages[0].content).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("buildRequestBody 的推理档位", () => {
  it("auto 什么都不发 —— 这是默认值，不该动上游的默认行为", () => {
    const body = buildRequestBody(options({ model: "gemini-2.5-pro" }), "cpa");
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("CPA 走模型名后缀，不发 reasoning_effort", () => {
    const body = buildRequestBody(options({ model: "gemini-2.5-pro", reasoningEffort: "high" }), "cpa");
    expect(body.model).toBe("gemini-2.5-pro(high)");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("其余后端走标准字段，模型名不动", () => {
    const body = buildRequestBody(options({ model: "gpt-5", reasoningEffort: "high" }), "generic");
    expect(body.model).toBe("gpt-5");
    expect(body.reasoning_effort).toBe("high");
  });

  it("模型名里已经手写了后缀就不再加一层", () => {
    const body = buildRequestBody(options({ model: "gemini-2.5-pro(8192)", reasoningEffort: "high" }), "cpa");
    expect(body.model).toBe("gemini-2.5-pro(8192)");
  });

  it("不是推理模型也照样加档位 —— 上层不再按模型能力拦，报错交给上游", () => {
    const body = buildRequestBody(options({ model: "deepseek-chat", reasoningEffort: "low" }), "generic");
    expect(body.reasoning_effort).toBe("low");
  });
});

describe("function web_search 调用循环", () => {
  it("Grok 自动模式保持单次原生搜索请求，不调用 Worker", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.tools).toEqual([{ type: "web_search" }]);
      return sseResponse([{ choices: [{ delta: { content: "原生搜索结果" } }] }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamChatCompletions(options({ model: "grok-4", webSearch: true }));

    expect(result.text).toBe("原生搜索结果");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("拼接流式参数，执行多个搜索并把 tool 结果回填给下一轮", async () => {
    const modelBodies: Array<Record<string, unknown>> = [];
    const searchBodies: Array<Record<string, unknown>> = [];
    let modelRequest = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === "/__api/search") {
        searchBodies.push(body);
        return Response.json({
          ok: true,
          query: body.query,
          provider: "bing-rss",
          items: [{ title: `结果：${body.query}`, snippet: "摘要", url: "https://example.com/source" }],
        });
      }

      modelBodies.push(body);
      modelRequest += 1;
      if (modelRequest === 1) {
        return sseResponse([
          { choices: [{ delta: { tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "web_search", arguments: "{\"que" } },
            { index: 1, id: "call_b", type: "function", function: { name: "web_search", arguments: "{\"query\":\"Grok " } },
          ] } }] },
          { choices: [{ delta: { tool_calls: [
            { index: 0, function: { arguments: "ry\":\"DeepSeek V4\"}" } },
            { index: 1, function: { arguments: "search\"}" } },
          ] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      return sseResponse([
        { choices: [{ delta: { content: "查到了，两条来源都在这里。" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const updates: string[] = [];
    const result = await streamChatCompletions(options({
      model: "DeepSeek-V4-Flash-0731",
      webSearch: true,
      searchProvider: "bing-rss",
      onUpdate: (snapshot) => updates.push(snapshot.tools.map((tool) => tool.status).join(",")),
    }));

    expect(result.text).toBe("查到了，两条来源都在这里。");
    expect(result.tools).toHaveLength(2);
    expect(result.tools.every((tool) => tool.status === "completed")).toBe(true);
    expect(searchBodies.map((body) => body.query)).toEqual(["DeepSeek V4", "Grok search"]);
    expect(updates).toContain("completed,completed");

    expect(modelBodies[0]?.tools).toEqual([expect.objectContaining({ type: "function" })]);
    expect(modelBodies[0]?.tool_choice).toBe("auto");
    const followUpMessages = modelBodies[1]?.messages as Array<Record<string, unknown>>;
    expect(followUpMessages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect((followUpMessages[2]?.tool_calls as unknown[])).toHaveLength(2);
    expect(followUpMessages[3]).toMatchObject({ role: "tool", tool_call_id: "call_a", name: "web_search" });
    expect(String(followUpMessages[3]?.content)).toContain("https://example.com/source");
  });

  it("非流式多个调用按数组位置分开，并兼容对象形式的 arguments", async () => {
    const searchBodies: Array<Record<string, unknown>> = [];
    const modelBodies: Array<Record<string, unknown>> = [];
    let modelRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input) === "/__api/search") {
        searchBodies.push(body);
        return Response.json({
          ok: true,
          query: body.query,
          provider: "duckduckgo",
          items: [{ title: "result", snippet: "snippet" }],
        });
      }
      modelBodies.push(body);
      modelRequest += 1;
      return modelRequest === 1
        ? jsonResponse({ content: "", tool_calls: [
          {
            id: "call_first",
            type: "function",
            function: { name: "web_search", arguments: { query: "first query" } },
          },
          {
            id: "call_second",
            type: "function",
            function: { name: "web_search", arguments: { query: "second query" } },
          },
        ] })
        : jsonResponse({ content: "两次搜索都完成了。" });
    }));

    const result = await streamChatCompletions(options({ model: "deepseek-chat", webSearch: true }));

    expect(result.text).toBe("两次搜索都完成了。");
    expect(searchBodies.map((body) => body.query)).toEqual(["first query", "second query"]);
    const messages = modelBodies[1]?.messages as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ tool_call_id: "call_first" }),
      expect.objectContaining({ tool_call_id: "call_second" }),
    ]);
  });

  it("搜索接口失败会作为 failed tool 结果回填，而不是中断对话", async () => {
    const modelBodies: Array<Record<string, unknown>> = [];
    let modelRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/__api/search") {
        return Response.json({ error: "搜索服务暂时不可用" }, { status: 503 });
      }
      modelBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      modelRequest += 1;
      return modelRequest === 1
        ? jsonResponse({ content: "", tool_calls: [{
          id: "call_fail",
          type: "function",
          function: { name: "web_search", arguments: "{\"query\":\"latest news\"}" },
        }] })
        : jsonResponse({ content: "现在无法取得搜索结果。" });
    }));

    const result = await streamChatCompletions(options({ model: "deepseek-chat", webSearch: true }));

    expect(result.text).toBe("现在无法取得搜索结果。");
    expect(result.tools).toEqual([expect.objectContaining({ status: "failed" })]);
    const messages = modelBodies[1]?.messages as Array<Record<string, unknown>>;
    expect(String(messages.at(-1)?.content)).toContain("搜索服务暂时不可用");
  });

  it("Worker 未授权时直接停止，不额外请求模型", async () => {
    let modelRequest = 0;
    let searchRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/__api/search") {
        searchRequest += 1;
        return Response.json({ error: "未授权" }, { status: 401 });
      }
      modelRequest += 1;
      return jsonResponse({ content: "", tool_calls: [{
        id: "call_auth",
        type: "function",
        function: { name: "web_search", arguments: { query: "today weather" } },
      }] });
    }));

    await expect(streamChatCompletions(options({ model: "deepseek-chat", webSearch: true })))
      .rejects.toThrow("设置的“联网”页验证访问口令");
    expect(modelRequest).toBe(1);
    expect(searchRequest).toBe(1);
  });

  it("模型一次发八个搜索调用时只执行两个，随后去掉 tools 强制收束", async () => {
    const modelBodies: Array<Record<string, unknown>> = [];
    let modelRequest = 0;
    let searchRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/__api/search") {
        searchRequest += 1;
        return Response.json({
          ok: true,
          query: `query-${searchRequest}`,
          provider: "duckduckgo",
          items: [{ title: "result", snippet: "snippet" }],
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      modelBodies.push(body);
      modelRequest += 1;
      return modelRequest === 1
        ? jsonResponse({ content: "", tool_calls: Array.from({ length: 8 }, (_, index) => ({
          id: `call_${index + 1}`,
          type: "function",
          function: { name: "web_search", arguments: `{\"query\":\"query-${index + 1}\"}` },
        })) })
        : jsonResponse({ content: "依据两次搜索完成回答。" });
    }));

    const result = await streamChatCompletions(options({ model: "unknown-model", webSearch: true }));

    expect(result.text).toBe("依据两次搜索完成回答。");
    expect(searchRequest).toBe(2);
    expect(modelRequest).toBe(2);
    expect(result.tools).toHaveLength(2);
    expect(modelBodies[1]).not.toHaveProperty("tools");
    const finalMessages = modelBodies[1]?.messages as Array<Record<string, unknown>>;
    expect(finalMessages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect((finalMessages.find((message) => message.role === "assistant")?.tool_calls as unknown[])).toHaveLength(2);
    expect(String((modelBodies[0]?.messages as Array<Record<string, unknown>>)[0]?.content)).toContain("最多调用两次");
  });

  it("相同搜索词的多个工具调用复用一次 Worker 结果", async () => {
    let modelRequest = 0;
    let searchRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/__api/search") {
        searchRequest += 1;
        return Response.json({
          ok: true,
          query: "香港 今日 天气",
          provider: "bing-rss",
          items: [{ title: "香港天气", snippet: "天气摘要" }],
        });
      }
      modelRequest += 1;
      return modelRequest === 1
        ? jsonResponse({ content: "", tool_calls: [
          {
            id: "call_first",
            type: "function",
            function: { name: "web_search", arguments: { query: "香港 今日 天气" } },
          },
          {
            id: "call_duplicate",
            type: "function",
            function: { name: "web_search", arguments: { query: "香港  今日  天气" } },
          },
        ] })
        : jsonResponse({ content: "复用搜索结果后作答。" });
    }));

    const result = await streamChatCompletions(options({ model: "deepseek-chat", webSearch: true }));

    expect(result.text).toBe("复用搜索结果后作答。");
    expect(result.tools).toHaveLength(2);
    expect(searchRequest).toBe(1);
    expect(modelRequest).toBe(2);
  });

  it("强制收束仍只返回工具调用时给出明确错误", async () => {
    let modelRequest = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/__api/search") {
        return Response.json({
          ok: true,
          query: "weather",
          provider: "duckduckgo",
          items: [{ title: "result", snippet: "snippet" }],
        });
      }
      modelRequest += 1;
      return jsonResponse({ content: "", tool_calls: [{
        id: `call_${modelRequest}`,
        type: "function",
        function: { name: "web_search", arguments: { query: "weather" } },
      }] });
    }));

    await expect(streamChatCompletions(options({ model: "unknown-model", webSearch: true })))
      .rejects.toThrow("达到函数搜索调用上限后仍未生成最终回答");
    expect(modelRequest).toBe(3);
  });

  it("搜索执行期间取消会终止整个工具循环", async () => {
    const controller = new AbortController();
    let markSearchStarted: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== "/__api/search") {
        return jsonResponse({ content: "", tool_calls: [{
          id: "call_abort",
          type: "function",
          function: { name: "web_search", arguments: "{\"query\":\"cancel me\"}" },
        }] });
      }
      markSearchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }));

    const pending = streamChatCompletions(options({
      model: "deepseek-chat",
      webSearch: true,
      signal: controller.signal,
    }));
    await searchStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("请求超时", () => {
  it("聊天接口建连卡住时抛出 TimeoutError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const pending = streamChatCompletions(options({ requestTimeoutMs: 20 }));
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      timeoutMs: 20,
      message: expect.stringContaining("连接聊天接口"),
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("收到 SSE 响应头后外部取消仍会中止流", async () => {
    const controller = new AbortController();
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => { markResponseReady = resolve; });
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          fetchSignal?.addEventListener("abort", () => stream.error(fetchSignal?.reason), { once: true });
          markResponseReady?.();
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    }));

    const pending = streamChatCompletions(options({ signal: controller.signal }));
    await responseReady;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSignal?.aborted).toBe(true);
  });
});
