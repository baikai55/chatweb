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

  it("未启用 token 时匿名搜索/上传默认失败关闭", async () => {
    const env = makeEnv();
    const fetchMock = vi.fn(async () => Response.json({
      AbstractText: "origin result",
      Heading: "Origin",
      AbstractURL: "https://example.com/origin",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const configResponse = await worker.fetch(new Request("https://chat.example/__api/config"), env);
    const sameOriginMetadata = await worker.fetch(searchRequest({ "sec-fetch-site": "same-origin" }), env);
    const exactOrigin = await worker.fetch(searchRequest({ origin: "https://chat.example" }), env);

    await expect(configResponse.json()).resolves.toMatchObject({
      searchAvailable: false,
      uploadAvailable: false,
    });
    expect(sameOriginMetadata.status).toBe(401);
    expect(exactOrigin.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("显式匿名开关只接受 same-origin 或精确 Origin，不接受 same-site", async () => {
    const env = makeEnv({ ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true" });
    const fetchMock = vi.fn(async () => Response.json({
      AbstractText: "origin result",
      Heading: "Origin",
      AbstractURL: "https://example.com/origin",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const missingHeaders = await worker.fetch(searchRequest(), env);
    const sameSite = await worker.fetch(searchRequest({ "sec-fetch-site": "same-site" }), env);
    const wrongOrigin = await worker.fetch(searchRequest({ origin: "https://evil.example" }), env);
    const exactOrigin = await worker.fetch(searchRequest({ origin: "https://chat.example" }), env);
    const sameOrigin = await worker.fetch(searchRequest({ "sec-fetch-site": "same-origin" }), env);

    expect(missingHeaders.status).toBe(401);
    expect(sameSite.status).toBe(401);
    expect(wrongOrigin.status).toBe(401);
    expect(exactOrigin.status).toBe(200);
    expect(sameOrigin.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("服务端密钥 proxy 必须持有有效 token，且响应不开放通配 CORS", async () => {
    const upstreamOnlyEnv = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      UPSTREAM_BASE_URL: "https://upstream.example/v1",
      UPSTREAM_API_KEY: "upstream-key",
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("upstream", {
      headers: {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const anonymous = await worker.fetch(proxyRequest({ "sec-fetch-site": "same-origin" }), upstreamOnlyEnv);
    expect(anonymous.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const protectedEnv = makeEnv({
      ACCESS_PASSWORD: "password",
      TOKEN_SECRET: "a-long-token-secret",
      UPSTREAM_BASE_URL: "https://upstream.example/v1",
      UPSTREAM_API_KEY: "upstream-key",
    });
    const missingToken = await worker.fetch(proxyRequest({ "sec-fetch-site": "same-origin" }), protectedEnv);
    const token = await issueToken(protectedEnv, Math.floor(Date.now() / 1000));
    const allowed = await worker.fetch(proxyRequest({
      authorization: `Bearer ${token}`,
      origin: "https://evil.example",
    }), protectedEnv);

    expect(missingToken.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://upstream.example/v1/models");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer upstream-key");
  });

  it("proxy 只允许已声明的端点、方法和请求体类型", async () => {
    const env = makeEnv({
      ACCESS_PASSWORD: "password",
      TOKEN_SECRET: "a-long-token-secret",
      UPSTREAM_BASE_URL: "https://upstream.example/v1",
      UPSTREAM_API_KEY: "upstream-key",
    });
    const fetchMock = vi.fn(async () => new Response("ok", {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const token = await issueToken(env, Math.floor(Date.now() / 1000));
    const authorization = { Authorization: `Bearer ${token}` };

    const unknownPath = await worker.fetch(new Request("https://chat.example/__api/proxy/admin/config", {
      headers: authorization,
    }), env);
    const wrongMethod = await worker.fetch(new Request("https://chat.example/__api/proxy/models", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{}",
    }), env);
    const wrongContentType = await worker.fetch(new Request("https://chat.example/__api/proxy/chat/completions", {
      method: "POST",
      headers: { ...authorization, "content-type": "text/plain" },
      body: "{}",
    }), env);
    const oversizedJSON = await worker.fetch(new Request("https://chat.example/__api/proxy/chat/completions", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
      body: "{}",
    }), env);
    const allowed = await worker.fetch(new Request("https://chat.example/__api/proxy/chat/completions", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    }), env);

    expect(unknownPath.status).toBe(403);
    expect(wrongMethod.status).toBe(400);
    expect(wrongContentType.status).toBe(400);
    expect(oversizedJSON.status).toBe(400);
    expect(allowed.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("proxy 在缺失 Content-Length 时也会按实际流入字节截断请求体", async () => {
    const env = makeEnv({
      ACCESS_PASSWORD: "password",
      TOKEN_SECRET: "a-long-token-secret",
      UPSTREAM_BASE_URL: "https://upstream.example/v1",
      UPSTREAM_API_KEY: "upstream-key",
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) await new Response(init.body as BodyInit).arrayBuffer();
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await issueToken(env, Math.floor(Date.now() / 1000));
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const response = await worker.fetch(new Request("https://chat.example/__api/proxy/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("超过大小上限") });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("上传在缺失 Content-Length 时按实际流入字节执行硬上限", async () => {
    const put = vi.fn();
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "8",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const request = streamingBytesRequest("https://chat.example/__api/upload", bytes, {
      "content-type": "image/png",
      "x-upload-length": "8",
      "sec-fetch-site": "same-origin",
    });

    expect(request.headers.get("content-length")).toBeNull();
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("有长度的裸 body 校验魔数后以流写入 R2", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    let uploaded = new Uint8Array();
    const put = vi.fn(async (_key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob) => {
      expect(value).toBeInstanceOf(ReadableStream);
      uploaded = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      return { size: uploaded.byteLength } as R2Object;
    });
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "16",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const request = streamingBytesRequest("https://chat.example/__api/upload", bytes, {
      "content-type": "image/png",
      "x-upload-length": String(bytes.byteLength),
      "sec-fetch-site": "same-origin",
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contentType: "image/png",
      size: bytes.byteLength,
      url: expect.stringContaining("/__api/media/uploads/"),
    });
    expect(uploaded).toEqual(bytes);
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^uploads\/\d{8}\/[a-z0-9]+\.png$/),
      expect.any(ReadableStream),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "image/png" }),
      }),
    );
  });

  it("裸 body 的声明长度与实际不一致时拒绝写入", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const put = vi.fn(async (_key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob) => {
      await new Response(value as BodyInit).arrayBuffer();
      return { size: bytes.byteLength } as R2Object;
    });
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "16",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const request = streamingBytesRequest("https://chat.example/__api/upload", bytes, {
      "content-type": "image/png",
      "x-upload-length": String(bytes.byteLength + 1),
      "sec-fetch-site": "same-origin",
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("长度") });
    expect(put).toHaveBeenCalledOnce();
  });

  it("Content-Length 与 X-Upload-Length 冲突时在写入 R2 前拒绝", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const put = vi.fn();
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "16",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const request = streamingBytesRequest("https://chat.example/__api/upload", bytes, {
      "content-length": String(bytes.byteLength),
      "content-type": "image/png",
      "x-upload-length": String(bytes.byteLength + 1),
      "sec-fetch-site": "same-origin",
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("不一致") });
    expect(put).not.toHaveBeenCalled();
  });

  it("保留 multipart 上传兼容且直接把解析出的 File 交给 R2", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const put = vi.fn(async (_key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob) => {
      expect(value).toBeInstanceOf(File);
      expect(new Uint8Array(await (value as Blob).arrayBuffer())).toEqual(bytes);
      return { size: (value as Blob).size } as R2Object;
    });
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "16",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const form = new FormData();
    form.set("file", new File([bytes], "photo.jpg", { type: "image/jpeg" }));
    const request = new Request("https://chat.example/__api/upload", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: form,
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ contentType: "image/jpeg", size: bytes.byteLength });
    expect(put).toHaveBeenCalledOnce();
  });

  it("multipart 上传体也受文件上限加固定封装开销的硬限制", async () => {
    const put = vi.fn();
    const env = makeEnv({
      ALLOW_ANONYMOUS_SAME_ORIGIN_SEARCH_UPLOAD: "true",
      MAX_UPLOAD_BYTES: "8",
      MEDIA: { put } as unknown as R2Bucket,
    });
    const request = streamingBytesRequest(
      "https://chat.example/__api/upload",
      new Uint8Array(8 + 64 * 1024 + 1),
      {
        "content-type": "multipart/form-data; boundary=upload-boundary",
        "sec-fetch-site": "same-origin",
      },
    );

    expect(request.headers.get("content-length")).toBeNull();
    const response = await worker.fetch(request, env);

    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
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

describe("Worker 公开媒体读取", () => {
  const key = "uploads/20260819/abc123.mp4";
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

  it("拒绝非法对象键，并把缺失对象返回为 404", async () => {
    const head = vi.fn(async () => null);
    const env = makeEnv({ MEDIA: { head } as unknown as R2Bucket });

    const invalid = await worker.fetch(
      new Request("https://chat.example/__api/media/not-an-upload"),
      env,
    );
    const missing = await worker.fetch(
      new Request(`https://chat.example/__api/media/${key}`),
      env,
    );

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(head).toHaveBeenCalledOnce();
  });

  it("GET 返回完整媒体及缓存、ETag 和字节范围元数据", async () => {
    const { bucket, get } = mediaBucket(bytes);
    const response = await worker.fetch(
      new Request(`https://chat.example/__api/media/${key}`),
      makeEnv({ MEDIA: bucket }),
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe('"media-etag"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get).toHaveBeenCalledWith(key, undefined);
  });

  it("HEAD 和命中 If-None-Match 时不读取 R2 正文", async () => {
    const { bucket, get } = mediaBucket(bytes);
    const env = makeEnv({ MEDIA: bucket });

    const head = await worker.fetch(new Request(`https://chat.example/__api/media/${key}`, {
      method: "HEAD",
    }), env);
    const notModified = await worker.fetch(new Request(`https://chat.example/__api/media/${key}`, {
      headers: { "If-None-Match": 'W/"media-etag"' },
    }), env);

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe('"media-etag"');
    expect(notModified.headers.get("content-length")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("单段 Range 返回 206，后缀范围可用，越界范围返回 416", async () => {
    const { bucket, get } = mediaBucket(bytes);
    const env = makeEnv({ MEDIA: bucket });

    const partial = await worker.fetch(new Request(`https://chat.example/__api/media/${key}`, {
      headers: { Range: "bytes=2-5" },
    }), env);
    const suffix = await worker.fetch(new Request(`https://chat.example/__api/media/${key}`, {
      headers: { Range: "bytes=-2" },
    }), env);
    const invalid = await worker.fetch(new Request(`https://chat.example/__api/media/${key}`, {
      headers: { Range: "bytes=99-100" },
    }), env);

    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(2, 6));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 6-7/8");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(6));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */8");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, key, { range: { offset: 2, length: 4 } });
    expect(get).toHaveBeenNthCalledWith(2, key, { range: { offset: 6, length: 2 } });
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

function proxyRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://chat.example/__api/proxy/models", { headers });
}

function streamingRequest(url: string, body: string): Request {
  const bytes = new TextEncoder().encode(body);
  return streamingBytesRequest(url, bytes, { "content-type": "application/json" });
}

function streamingBytesRequest(url: string, bytes: Uint8Array, headers: Record<string, string>): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
      controller.enqueue(bytes.subarray(0, midpoint));
      controller.enqueue(bytes.subarray(midpoint));
      controller.close();
    },
  });
  return new Request(url, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit);
}

function mediaBucket(bytes: Uint8Array): {
  bucket: R2Bucket;
  get: ReturnType<typeof vi.fn>;
} {
  const metadata = {
    size: bytes.byteLength,
    httpEtag: '"media-etag"',
    writeHttpMetadata(headers: Headers) {
      headers.set("Content-Type", "video/mp4");
    },
  } as R2Object;
  const get = vi.fn(async (_key: string, options?: R2GetOptions) => {
    const range = options?.range as { offset: number; length: number } | undefined;
    const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return {
      ...metadata,
      body: new Response(body).body,
    } as R2ObjectBody;
  });
  return {
    bucket: {
      head: vi.fn(async () => metadata),
      get,
    } as unknown as R2Bucket,
    get,
  };
}
