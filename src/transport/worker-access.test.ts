import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateWorker,
  clearWorkerAccessToken,
  fetchWorkerApi,
  hasWorkerAccessToken,
} from "@/transport/worker-access";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

afterEach(() => {
  vi.useRealTimers();
  clearWorkerAccessToken();
  vi.unstubAllGlobals();
});

describe("Worker 访问 token", () => {
  it("用口令换 token，口令不落盘，后续 Worker 请求自动带 Bearer", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const token = `${Math.floor(Date.now() / 1000) + 3600}.signed-token`;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/__api/auth") return Response.json({ token });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await authenticateWorker("access-password");
    await fetchWorkerApi("/__api/upload", { method: "POST", body: new FormData() });

    expect(hasWorkerAccessToken()).toBe(true);
    expect(Array.from(storage.values.values())).toEqual([token]);
    expect(Array.from(storage.values.values())).not.toContain("access-password");
    const authBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(authBody).toEqual({ password: "access-password" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("content-type")).toBeNull();
  });

  it("受保护接口返回 401 后清掉旧 token", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    const token = `${Math.floor(Date.now() / 1000) + 3600}.old-token`;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ token }))
      .mockResolvedValueOnce(Response.json({ error: "未授权" }, { status: 401 })));

    await authenticateWorker("password");
    const response = await fetchWorkerApi("/__api/search", { method: "POST" });

    expect(response.status).toBe(401);
    expect(hasWorkerAccessToken()).toBe(false);
    expect(storage.length).toBe(0);
  });

  it("过期 token 不会被发送", async () => {
    const storage = memoryStorage();
    storage.setItem("chatweb:worker-access-token", `${Math.floor(Date.now() / 1000) - 1}.expired`);
    vi.stubGlobal("sessionStorage", storage);
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkerApi("/__api/search");

    expect(hasWorkerAccessToken()).toBe(false);
    expect(storage.length).toBe(0);
  });

  it("认证响应正文超时会中止底层请求", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return Promise.resolve(response);
    }));

    const authenticating = authenticateWorker("password");
    const assertion = expect(authenticating).rejects.toMatchObject({
      name: "TimeoutError",
      code: "request_timeout",
      message: expect.stringContaining("读取 Worker 认证响应"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("外部取消认证时保留原 AbortError", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const authenticating = authenticateWorker("password", controller.signal);
    controller.abort();

    await expect(authenticating).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
  });
});

function memoryStorage(): Storage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
