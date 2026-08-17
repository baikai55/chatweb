import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateWorker,
  clearWorkerAccessToken,
  fetchWorkerApi,
  hasWorkerAccessToken,
} from "@/transport/worker-access";

afterEach(() => {
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
