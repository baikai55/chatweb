import { describe, expect, it } from "vitest";

import { readError, toTransportError } from "@/transport/errors";

function failed(status: number, body: string, headers: Record<string, string> = {}) {
  return toTransportError(new Response(body, { status, headers }), body);
}

describe("readError 兼容各家的错误体形状", () => {
  it("CPA 的 error 是字符串", () => {
    expect(readError({ error: "Missing API key" }).message).toBe("Missing API key");
  });

  it("OpenAI 标准的 error 是对象", () => {
    const parsed = readError({ error: { message: "bad request", type: "invalid_request_error" } });
    expect(parsed.message).toBe("bad request");
    expect(parsed.code).toBe("invalid_request_error");
  });

  it("FastAPI 风格的 detail 先剥一层", () => {
    expect(readError({ detail: { error: "boom" } }).message).toBe("boom");
  });

  it("裸字符串也认", () => {
    expect(readError("plain failure").message).toBe("plain failure");
  });
});

describe("toTransportError 给费解的报错补一句人话", () => {
  it("400 里出现 web_search 时提示切到函数搜索", () => {
    // 实测：CPA 转发到 oneapi 上的第三方 DeepSeek 会回这一句。
    // 原文全是 deserialize / target type，完全指不到"是我点了那个按钮"。
    const body = JSON.stringify({
      error: {
        message: "Failed to deserialize the JSON body into the target type: unknown variant `web_search`, expected `function` at line 1 column 552",
        type: "bad_response_status_code",
      },
    });
    const error = failed(400, body);
    expect(error.message).toContain("联网方式改成「函数」");
    expect(error.message).toContain("关闭工具栏里的「联网」");
    expect(error.message).toContain("unknown variant");
  });

  it("跟联网无关的 400 不乱加提示", () => {
    const error = failed(400, JSON.stringify({ error: "prompt too long" }));
    expect(error.message).toBe("prompt too long");
  });

  it("CPA safe-mode 的 403 说清是服务端没配好", () => {
    const error = failed(403, JSON.stringify({ error: "unsafe_example_api_key" }));
    expect(error.message).toContain("服务端配置问题");
  });

  it("404 不再让用户去重新探测 —— 那个功能已经删了", () => {
    const error = failed(404, JSON.stringify({ error: "404 page not found" }));
    expect(error.message).toContain("显示哪些面板");
    expect(error.message).not.toContain("探测");
  });

  it("带上响应头里的 request id", () => {
    const error = failed(500, "boom", { "X-Request-ID": "req_123" });
    expect(error.requestId).toBe("req_123");
  });
});
