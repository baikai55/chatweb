import { afterEach, describe, expect, it, vi } from "vitest";

import { issueToken, type Env } from "./auth";
import worker from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Worker 访问控制", () => {
  it("访问控制只配置一项时失败关闭", async () => {
    const env = makeEnv({ ACCESS_PASSWORD: "password" });

    const configResponse = await worker.fetch(new Request("https://chat.example/__api/config"), env);
    await expect(configResponse.json()).resolves.toMatchObject({ authRequired: true, proxyAvailable: false });

    const authResponse = await worker.fetch(new Request("https://chat.example/__api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "password" }),
    }), env);
    const searchResponse = await worker.fetch(searchRequest({ "sec-fetch-site": "same-origin" }), env);

    expect(authResponse.status).toBe(500);
    await expect(authResponse.json()).resolves.toMatchObject({ error: expect.stringContaining("必须同时配置") });
    expect(searchResponse.status).toBe(401);
  });

  it("只配置访问控制时也能签发 token，proxyAvailable 仍为 false", async () => {
    const env = makeEnv({ ACCESS_PASSWORD: "password", TOKEN_SECRET: "a-long-token-secret" });

    const configResponse = await worker.fetch(new Request("https://chat.example/__api/config"), env);
    const config = await configResponse.json() as Record<string, unknown>;
    expect(config).toMatchObject({
      proxyAvailable: false,
      searchAvailable: true,
      authRequired: true,
      uploadAvailable: false,
    });

    const authResponse = await worker.fetch(new Request("https://chat.example/__api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "password" }),
    }), env);
    const auth = await authResponse.json() as { token?: string };

    expect(authResponse.status).toBe(200);
    expect(auth.token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);

    const proxyConfigResponse = await worker.fetch(new Request("https://chat.example/__api/config"), makeEnv({
      ACCESS_PASSWORD: "password",
      TOKEN_SECRET: "a-long-token-secret",
      UPSTREAM_BASE_URL: "https://api.example/v1",
      UPSTREAM_API_KEY: "upstream-key",
    }));
    await expect(proxyConfigResponse.json()).resolves.toMatchObject({ proxyAvailable: true });
  });

  it("token 访问控制不依赖上游代理配置", async () => {
    const env = makeEnv({ ACCESS_PASSWORD: "password", TOKEN_SECRET: "a-long-token-secret" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      AbstractText: "protected result",
      Heading: "Protected",
      AbstractURL: "https://example.com/protected",
    })));

    const denied = await worker.fetch(searchRequest({ "sec-fetch-site": "same-origin" }), env);
    expect(denied.status).toBe(401);

    const authResponse = await worker.fetch(new Request("https://chat.example/__api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "password" }),
    }), env);
    const { token } = await authResponse.json() as { token: string };
    const allowed = await worker.fetch(searchRequest({ authorization: `Bearer ${token}` }), env);
    const expiredToken = await issueToken(env, 0);
    const expired = await worker.fetch(searchRequest({ authorization: `Bearer ${expiredToken}` }), env);
    const malformed = await worker.fetch(searchRequest({ authorization: "Bearer malformed" }), env);

    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ ok: true, provider: "duckduckgo" });
    expect(expired.status).toBe(401);
    expect(malformed.status).toBe(401);
  });

  it("未启用 token 时，缺失 Fetch Metadata 必须提供精确同源 Origin", async () => {
    const env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      AbstractText: "origin result",
      Heading: "Origin",
      AbstractURL: "https://example.com/origin",
    })));

    const missingHeaders = await worker.fetch(searchRequest(), env);
    const wrongOrigin = await worker.fetch(searchRequest({ origin: "https://evil.example" }), env);
    const exactOrigin = await worker.fetch(searchRequest({ origin: "https://chat.example" }), env);

    expect(missingHeaders.status).toBe(401);
    expect(wrongOrigin.status).toBe(401);
    expect(exactOrigin.status).toBe(200);
  });

  it("认证请求也按实际流入字节执行硬上限", async () => {
    const env = makeEnv({ ACCESS_PASSWORD: "password", TOKEN_SECRET: "a-long-token-secret" });
    const payload = JSON.stringify({ password: "x".repeat(9 * 1024) });
    const request = streamingRequest("https://chat.example/__api/auth", payload);

    expect(request.headers.get("content-length")).toBeNull();
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(413);
  });
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    ...overrides,
  };
}

function searchRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://chat.example/__api/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query: "test", provider: "duckduckgo" }),
  });
}

function streamingRequest(url: string, body: string): Request {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4 * 1024));
      controller.enqueue(bytes.subarray(4 * 1024));
      controller.close();
    },
  });
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
}
