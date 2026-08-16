import { isProxyModeConfigured, issueToken, readBearer, timingSafeEqual, verifyToken, type Env } from "./auth";
import { handleProxy } from "./proxy";
import { handleMediaRead, handleUpload, json } from "./upload";

/**
 * chatweb 的 Worker 入口。
 *
 * 职责有三：
 *   1. 托管静态 SPA（env.ASSETS，SPA 兜底路由）
 *   2. R2 上传通道 —— 两种模式下都要用，因为视频编辑需要公网可达的源文件 URL
 *   3. 可选的服务端密钥反代 —— 只在要把链接分享给别人时才需要
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

  // 公开：告诉前端服务端有没有预置后端。绝不返回 key。
  if (path === "/config" && request.method === "GET") {
    return json({
      proxyAvailable: isProxyModeConfigured(env),
      uploadAvailable: Boolean(env.MEDIA),
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
    if (!isProxyModeConfigured(env)) {
      return json({ error: "服务端没有启用预置后端模式" }, 501);
    }
    const body = (await request.json().catch(() => null)) as { password?: string } | null;
    const password = body?.password ?? "";
    if (!password || !timingSafeEqual(password, env.ACCESS_PASSWORD ?? "")) {
      return json({ error: "访问口令不对" }, 401);
    }
    return json({ token: await issueToken(env, now) });
  }

  // 媒体读取是公开的 —— 上游服务（xAI 等）要能匿名抓到这个 URL
  if (path.startsWith("/media/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "只支持 GET" }, 405);
    }
    return handleMediaRead(path.slice("/media/".length), env);
  }

  // 以下都要鉴权
  const authorized = await isAuthorized(request, env, now);
  if (!authorized) {
    return json({ error: "未授权" }, 401);
  }

  if (path === "/upload" && request.method === "POST") {
    return handleUpload(request, env, url.origin);
  }

  if (path.startsWith("/proxy/")) {
    return handleProxy(request, env, path.slice("/proxy".length));
  }

  return json({ error: "没有这个接口" }, 404);
}

/**
 * 鉴权分两种情况：
 *   - 服务端密钥模式：必须持有有效 token
 *   - 纯直连模式（没配 ACCESS_PASSWORD）：上传通道对同源请求开放
 *
 * 后者看起来宽松，但这个部署本来就只有你自己在用；真要对外分享就该配上口令。
 * 用 Sec-Fetch-Site 拦掉最基本的第三方站点盗用。
 */
async function isAuthorized(request: Request, env: Env, now: number): Promise<boolean> {
  if (isProxyModeConfigured(env)) {
    return verifyToken(env, readBearer(request), now);
  }
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin" || site === "same-site";
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
