import { afterEach, describe, expect, it, vi } from "vitest";

import { toAsset } from "@/features/history/generation-store";
import { DEFAULT_MEDIA_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toAsset 媒体读取", () => {
  it("正文读取超时会中止 fetch 并回退保存原 URL", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "blob").mockImplementation(() => new Promise<Blob>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return Promise.resolve(response);
    }));

    const loading = toAsset("blob:history-media", "备注");
    const assertion = expect(loading).resolves.toEqual({ url: "blob:history-media", note: "备注" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_MEDIA_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("外部取消时保留 AbortError，不回退成失效 URL", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));

    const loading = toAsset("blob:history-media", undefined, controller.signal);
    controller.abort();

    await expect(loading).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
    expect(requestSignal).toMatchObject({ aborted: true });
  });
});
