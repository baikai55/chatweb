import {
  hasTokenAccessSettings,
  isAnonymousSameOriginSearchUploadEnabled,
  isProxyModeConfigured,
  isSearchUploadAccessConfigured,
  isTokenAccessConfigured,
  issueToken,
  readBearer,
  timingSafeEqual,
  verifyToken,
  type Env,
} from "./auth";
import { BodyTooLargeError, InvalidJsonBodyError, readJsonBodyWithLimit } from "./body";
import { handleProxy, ProxyBodyTooLargeError } from "./proxy";
import { handleSearch } from "./search";
import { handleMediaRead, handleUpload, json } from "./upload";

const MAX_AUTH_REQUEST_BYTES = 8 * 1024;

/**
 * chatweb 的 Worker 入口。
 *
 * 职责有四：
 *   1. 托管静态 SPA（env.ASSETS，SPA 兜底路由）
 *   2. R2 上传通道 —— 两种模式下都要用，因为视频编辑需要公网可达的源文件 URL
 *   3. 可选的服务端密钥反代 —— 只在要把链接分享给别人时才需要
 *   4. function tool 使用的联网搜索执行端
 *
 * 注意默认情况下**聊天请求根本不经过这里**：CPA 和 grok2api 的 CORS 都全开，
 * 浏览器直连更快也更省 Worker 用量。
 */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/__api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        if (error instanceof ProxyBodyTooLargeError) {
          return json({ error: error.message }, 413);
        }
        const message = error instanceof Error ? error.message : "未知错误";
        return json({ error: message }, 500);
      }
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.slice("/__api".length);
  const now = Math.floor(Date.now() / 1000);
  const searchUploadAvailable = isSearchUploadAccessConfigured(env);

  // 公开：告诉前端服务端有没有预置后端。绝不返回 key。
  if (path === "/config" && request.method === "GET") {
    return json({
      proxyAvailable: isProxyModeConfigured(env),
      searchAvailable: searchUploadAvailable,
      authRequired: hasTokenAccessSettings(env),
      uploadAvailable: Boolean(env.MEDIA) && searchUploadAvailable,
      name: env.UPSTREAM_NAME ?? "",
      capabilities: (env.UPSTREAM_CAPABILITIES ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 0) || null,
    });
  }

  // 公开：口令换 token
  if (path === "/auth" && request.method === "POST") {
    if (hasTokenAccessSettings(env) && !isTokenAccessConfigured(env)) {
      return json({ error: "访问控制配置不完整：ACCESS_PASSWORD 和 TOKEN_SECRET 必须同时配置" }, 500);
    }
    if (!isTokenAccessConfigured(env)) {
      return json({ error: "服务端没有启用访问口令" }, 501);
    }
    let rawBody: unknown;
    try {
      rawBody = await readJsonBodyWithLimit(request, MAX_AUTH_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ error: "认证请求太大" }, 413);
      if (error instanceof InvalidJsonBodyError) return json({ error: "认证请求必须是 JSON 对象" }, 400);
      throw error;
    }
    const body = isObject(rawBody) ? rawBody : null;
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password || !timingSafeEqual(password, env.ACCESS_PASSWORD ?? "")) {
      return json({ error: "访问口令不对" }, 401);
    }
    return json({ token: await issueToken(env, now) });
  }

  // 媒体读取是公开的 —— 上游服务（xAI 等）要能匿名抓到这个 URL
  if (path.startsWith("/media/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "只支持 GET/HEAD" }, 405);
    }
    return handleMediaRead(request, path.slice("/media/".length), env);
  }

  // 服务端密钥代理无条件要求有效 token，绝不接受浏览器来源头代替认证。
  if (path.startsWith("/proxy/")) {
    const authorized = isTokenAccessConfigured(env)
      && await verifyToken(env, readBearer(request), now);
    if (!authorized) return json({ error: "未授权" }, 401);
    return handleProxy(request, env, path.slice("/proxy".length));
  }

  // 搜索/上传可选择 token，或显式开启的匿名严格同源模式。
  const authorized = await isSearchUploadAuthorized(request, env, now);
  if (!authorized) {
    return json({ error: "未授权" }, 401);
  }

  if (path === "/upload" && request.method === "POST") {
    return handleUpload(request, env, url.origin);
  }

  if (path === "/search" && request.method === "POST") {
    return handleSearch(request, env);
  }

  return json({ error: "没有这个接口" }, 404);
}

/**
 * 鉴权分两种情况：
 *   - 配置了访问口令和签名密钥：必须持有有效 token
 *   - 没配置访问控制：默认拒绝；仅显式开启开关后接受严格同源请求
 *
 * same-site 不等于 same-origin，不能用于这个授权判断。
 */
async function isSearchUploadAuthorized(request: Request, env: Env, now: number): Promise<boolean> {
  if (hasTokenAccessSettings(env)) {
    return isTokenAccessConfigured(env) && verifyToken(env, readBearer(request), now);
  }
  if (!isAnonymousSameOriginSearchUploadEnabled(env)) return false;
  const site = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
  if (site === "same-origin") return true;
  return request.headers.get("Origin") === new URL(request.url).origin;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // key 存在 localStorage 里，XSS 就是丢 key，所以 CSP 收紧。
  // connect-src 必须留 * —— 用户配的后端地址是任意的。
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src *",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join("; "),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
