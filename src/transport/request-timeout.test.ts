import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequestTimeoutScope, TimeoutError } from "@/transport/request-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestTimeoutScope", () => {
  it("阶段超时抛出 TimeoutError 并中止交给 fetch 的信号", async () => {
    vi.useFakeTimers();
    const request = createRequestTimeoutScope();
    const pending = request.run(() => new Promise<Response>(() => undefined), 25, "连接测试接口");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      status: 408,
      code: "request_timeout",
      timeoutMs: 25,
      message: "连接测试接口超过 1 秒，已中断",
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBeInstanceOf(TimeoutError);
    request.dispose();
  });

  it("外部主动取消保留原 AbortError，不会伪装成超时", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = createRequestTimeoutScope(controller.signal);
    const pending = request.run(() => new Promise<Response>(() => undefined), 10_000);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await assertion;
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(controller.signal.reason);
    expect(request.signal.reason).not.toBeInstanceOf(TimeoutError);
    expect(vi.getTimerCount()).toBe(0);
    request.dispose();
  });

  it("可对建连和正文读取分别计时", async () => {
    vi.useFakeTimers();
    const request = createRequestTimeoutScope();
    await expect(request.run(async () => new Response("ok"), 20)).resolves.toBeInstanceOf(Response);

    const pendingBody = request.run(() => new Promise<string>(() => undefined), 20, "读取响应正文");
    const assertion = expect(pendingBody).rejects.toMatchObject({
      name: "TimeoutError",
      message: expect.stringContaining("读取响应正文"),
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    request.dispose();
  });
});
