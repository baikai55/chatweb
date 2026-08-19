import { describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import { generateImages, readImagesDeep } from "@/transport/images";

const BASE = "https://x.test/v1";

function urls(payload: unknown): string[] {
  return readImagesDeep(payload, BASE).map((image) => image.url);
}

describe("readImagesDeep", () => {
  it("标准 images 端点响应", () => {
    expect(urls({ data: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }] }))
      .toEqual(["https://cdn.test/a.png", "https://cdn.test/b.png"]);
  });

  it("b64_json 转成 data URL，并按魔数认出真实类型", () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    expect(urls({ data: [{ b64_json: png }] })).toEqual([`data:image/png;base64,${png}`]);
  });

  it("对话端点把图片放在 message.images 里", () => {
    const payload = {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          images: [{ type: "image_url", image_url: { url: "https://cdn.test/c.png" } }],
        },
      }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/c.png"]);
  });

  it("对话端点只把图片拼在正文 markdown 里时也能取出来", () => {
    const payload = {
      choices: [{ message: { content: "画好了：\n\n![一只猫](https://cdn.test/d.png)\n\n还需要改吗？" } }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/d.png"]);
  });

  it("正文里的裸链接只认带图片扩展名的", () => {
    const payload = {
      choices: [{ message: { content: "看 https://cdn.test/e.webp ，文档在 https://docs.test/guide" } }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/e.webp"]);
  });

  it("正文里的 data URL 也认", () => {
    const payload = { choices: [{ message: { content: "![](data:image/gif;base64,R0lGODlhAQABAAAAdA==)" } }] };
    expect(urls(payload)).toEqual(["data:image/gif;base64,R0lGODlhAQABAAAAdA=="]);
  });

  it("同一张图在结构化字段和正文里各出现一次时只算一张", () => {
    const payload = {
      choices: [{
        message: {
          content: "![](https://cdn.test/f.png)",
          images: [{ image_url: { url: "https://cdn.test/f.png" } }],
        },
      }],
    };
    expect(urls(payload)).toEqual(["https://cdn.test/f.png"]);
  });

  it("相对路径按 baseURL 补全", () => {
    expect(urls({ data: [{ url: "/files/g.png" }] })).toEqual(["https://x.test/files/g.png"]);
  });

  it("错误信息里的链接不会被当成图片", () => {
    const payload = { error: { message: "见 https://docs.test/limits.png 说明" }, data: [] };
    expect(urls(payload)).toEqual([]);
  });

  it("没有任何图片时返回空数组", () => {
    expect(urls({ choices: [{ message: { content: "我没法生成图片。" } }] })).toEqual([]);
  });
});

describe("generateImages reference images", () => {
  it("标准图片路由带参考图时改走 multipart /images/edits", async () => {
    const nativeFetch = globalThis.fetch;
    const apiRequests: Array<{ body: FormData; headers: Headers }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("data:")) return nativeFetch(input, init);
      expect(url).toBe("https://x.test/v1/images/edits");
      apiRequests.push({ body: init?.body as FormData, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.test/edited.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const result = await generateImages({
        backend: createBackend({ name: "t", baseURL: "https://x.test/v1", apiKey: "secret" }),
        model: "gpt-image-2",
        prompt: "把背景改成夜晚",
        inputImages: ["data:image/png;base64,aGVsbG8="],
        n: 1,
        size: "auto",
        quality: "high",
        responseFormat: "url",
      });

      const apiRequest = apiRequests[0];
      expect(result).toEqual([{ url: "https://cdn.test/edited.png", revisedPrompt: undefined }]);
      expect(apiRequest.body).toBeInstanceOf(FormData);
      expect(apiRequest.body.get("model")).toBe("gpt-image-2");
      expect(apiRequest.body.get("prompt")).toBe("把背景改成夜晚");
      expect(apiRequest.body.get("size")).toBe("auto");
      expect(apiRequest.body.get("quality")).toBe("high");
      expect(apiRequest.body.get("image")).toBeInstanceOf(Blob);
      expect(apiRequest.headers.get("authorization")).toBe("Bearer secret");
      expect(apiRequest.headers.has("content-type")).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("读取参考图被取消时保留 AbortError", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("aborted", "AbortError"));
    try {
      await expect(generateImages({
        backend: createBackend({ name: "t", baseURL: "https://x.test/v1" }),
        model: "gpt-image-2",
        prompt: "修改图片",
        inputImages: ["https://cdn.test/reference.png"],
        n: 1,
        responseFormat: "url",
      })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("图片建连使用可配置的等待上限", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
    try {
      const pending = generateImages({
        backend: createBackend({ name: "t", baseURL: "https://x.test/v1" }),
        model: "gpt-image-2",
        prompt: "画一只猫",
        n: 1,
        responseFormat: "url",
        idleTimeoutMs: 25,
      });
      const assertion = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
        code: "request_timeout",
        timeoutMs: 25,
        message: expect.stringContaining("连接图片生成接口"),
      });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("收到 SSE 响应头后外部取消仍会中止图片流", async () => {
    const controller = new AbortController();
    let markResponseReady: (() => void) | undefined;
    const responseReady = new Promise<void>((resolve) => { markResponseReady = resolve; });
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          fetchSignal?.addEventListener("abort", () => stream.error(fetchSignal?.reason), { once: true });
          markResponseReady?.();
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    });
    try {
      const pending = generateImages({
        backend: createBackend({ name: "t", baseURL: "https://x.test/v1" }),
        model: "gpt-image-2",
        prompt: "画一只猫",
        n: 1,
        responseFormat: "url",
        signal: controller.signal,
      });
      await responseReady;
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
