import { describe, expect, it, vi } from "vitest";

import { buildRequestBody, streamChatCompletions, webSearchNote } from "@/transport/chat-completions";
import type { ChatCompletionsOptions } from "@/transport/chat-completions";
import { readChatContentText } from "@/transport/types";

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

  it("Claude 提示多半会被静默丢弃，但不拦着", () => {
    const result = webSearchNote("claude-sonnet-4-5");
    expect(result.known).toBe(false);
    expect(result.note).toContain("/v1/messages");
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

  it("认不出厂商时照发通用 web_search，而不是静默发空", () => {
    // 之前这里返回 []，开关看着生效了其实什么都没发出去。
    // 宁可让上游报个明确的错 —— 厂商判定本来就只是拿模型 id 猜的。
    const body = buildRequestBody(options({ model: "deepseek-chat", webSearch: true }), "generic");
    expect(body.tools).toEqual([{ type: "web_search" }]);
  });

  it("Claude 也照发 —— CPA 会静默过滤掉，但换个后端可能就认", () => {
    const body = buildRequestBody(options({ model: "claude-sonnet-4-5", webSearch: true }), "cpa");
    expect(body.tools).toEqual([{ type: "web_search" }]);
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
