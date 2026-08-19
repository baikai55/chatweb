import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVideoGeneration,
  getVideoGeneration,
  pollVideoGeneration,
} from "@/transport/videos";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("视频请求超时", () => {
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
