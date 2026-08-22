import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_VIDEO_ROUTE_DEFS } from "@/transport/video-routes";
import {
  createVideoGeneration,
  getVideoGeneration,
  pollVideoGeneration,
  readVideoGenerationStatus,
  readVideoURLFromText,
  uploadVideoInput,
} from "@/transport/videos";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("视频请求超时", () => {
  it("上传素材使用裸 File body 并保留 MIME", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "source.png", {
      type: "image/png",
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(file);
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("image/png");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("x-upload-length")).toBe(String(file.size));
      return Response.json({
        url: "https://chat.example/__api/media/uploads/20260819/source.png",
        contentType: "image/png",
        size: file.size,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadVideoInput(file)).resolves.toEqual({
      url: "https://chat.example/__api/media/uploads/20260819/source.png",
      contentType: "image/png",
      size: file.size,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("生成任务使用组合 signal，并解析 request_id", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
      return Response.json({ request_id: "video-1", status: "queued", progress: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createVideoGeneration({
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      model: "grok-video",
      prompt: "海边日落",
      signal: controller.signal,
    })).resolves.toMatchObject({
      requestId: "video-1",
      status: { requestId: "video-1", status: "pending" },
    });
  });

  it("状态响应正文卡住时按单次请求上限抛 TimeoutError", async () => {
    vi.useFakeTimers();
    const response = Response.json({ status: "pending" });
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const pending = getVideoGeneration({
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      requestId: "video-2",
      requestTimeoutMs: 30,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it("任务持续 pending 时按轮询总上限终止", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({
      request_id: "video-3",
      status: "processing",
      progress: 20,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = pollVideoGeneration({
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      requestId: "video-3",
      intervalMs: 10,
      pollTimeoutMs: 35,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      timeoutMs: 35,
      message: expect.stringContaining("等待视频生成"),
    });
    await vi.advanceTimersByTimeAsync(35);
    await assertion;
    expect(fetchMock).toHaveBeenCalled();
  });

  it("外部取消轮询仍抛 AbortError", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "pending" })));
    const controller = new AbortController();
    const pending = pollVideoGeneration({
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      requestId: "video-4",
      intervalMs: 10_000,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
  });
});

describe("对话端点生成视频", () => {
  const CHAT_INPUT = {
    baseURL: "https://api.example.test/v1",
    apiKey: "sk-test",
    model: "some-video-model",
    prompt: "海边日落",
    route: BUILTIN_VIDEO_ROUTE_DEFS.chat,
  };

  it("打 /chat/completions，并从回复正文的 markdown 链接里取视频", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.example.test/v1/chat/completions");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "some-video-model",
        messages: [{ role: "user", content: "海边日落" }],
        stream: false,
      });
      return Response.json({
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: "好了：[点击查看](https://cdn.test/out.mp4)" } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createVideoGeneration(CHAT_INPUT)).resolves.toMatchObject({
      status: { status: "done", progress: 100, video: { url: "https://cdn.test/out.mp4" } },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("正文写成 SSE 时也能取到视频", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"生成中"}}]}\n\n'
      + 'data: {"choices":[{"message":{"content":"https://cdn.test/out.webm"}}]}\n\n'
      + "data: [DONE]\n\n",
      { headers: { "content-type": "text/plain" } },
    )));

    await expect(createVideoGeneration(CHAT_INPUT)).resolves.toMatchObject({
      status: { status: "done", video: { url: "https://cdn.test/out.webm" } },
    });
  });

  it("同步路由拿不到视频地址时直接报错，不去轮询一个不存在的端点", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "chatcmpl-2",
      choices: [{ message: { content: "抱歉，我无法生成视频。" } }],
    })));

    await expect(createVideoGeneration(CHAT_INPUT)).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining("没有视频地址"),
    });
  });

  it("上游自己报的失败原因不会被“没有任务 ID”盖掉", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "failed",
      error: { message: "内容审核未通过", code: "content_policy" },
    })));

    await expect(createVideoGeneration(CHAT_INPUT)).resolves.toMatchObject({
      status: { status: "failed", error: { message: "内容审核未通过", code: "content_policy" } },
    });
  });
});

describe("自定义路由的取视频路径与状态路径", () => {
  it("videoUrlPaths 命中时优先于通用提取", () => {
    const status = readVideoGenerationStatus(
      { data: { clip: { link: "https://cdn.test/a.mp4" } }, url: "https://cdn.test/wrong.mp4" },
      "",
      "https://api.example.test/v1",
      ["data.clip.link"],
    );
    expect(status.video?.url).toBe("https://cdn.test/a.mp4");
  });

  it("路径写错时回落到通用提取，而不是什么都取不到", () => {
    const status = readVideoGenerationStatus(
      { video_url: "https://cdn.test/b.mp4" },
      "",
      "https://api.example.test/v1",
      ["typo.path"],
    );
    expect(status.video?.url).toBe("https://cdn.test/b.mp4");
  });

  it("轮询使用路由给的状态路径", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.example.test/v1/tasks/job-9/status");
      return Response.json({ status: "succeeded", video_url: "https://cdn.test/c.mp4" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVideoGeneration({
      baseURL: "https://api.example.test/v1",
      apiKey: "sk-test",
      requestId: "job-9",
      statusPath: "/tasks/${requestId}/status",
    })).resolves.toMatchObject({ status: "done", video: { url: "https://cdn.test/c.mp4" } });
  });
});

describe("readVideoURLFromText", () => {
  it("带视频扩展名的链接优先", () => {
    expect(readVideoURLFromText("先看[封面](https://cdn.test/cover.png)，再看 https://cdn.test/v.mp4"))
      .toBe("https://cdn.test/v.mp4");
  });

  it("没有扩展名时退回第一条普通 markdown 链接", () => {
    expect(readVideoURLFromText("结果：[下载](https://cdn.test/sign?token=abc)"))
      .toBe("https://cdn.test/sign?token=abc");
  });

  it("![]() 图片语法多半是封面，不作为候选", () => {
    expect(readVideoURLFromText("![预览](https://cdn.test/thumb.jpg)")).toBe("");
  });

  it("句尾标点不算进 URL", () => {
    expect(readVideoURLFromText("地址是 https://cdn.test/v.mp4。")).toBe("https://cdn.test/v.mp4");
  });
});
