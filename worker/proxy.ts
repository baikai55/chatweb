import type { Env } from "./auth";
import { json } from "./upload";

/**
 * 服务端密钥模式的反向代理。
 *
 * 浏览器直连模式下用不到这个 —— CPA 和 grok2api 的 CORS 都是全开的。
 * 它存在的唯一理由是：**让你能把链接分享给别人而不泄露 API key**。
 *
 * CPA 对客户端 key 没有任何配额或限流（config_access/provider.go:92 就是一次
 * map 成员检查），所以 key 一旦泄露等于把所有上游额度公开。
 */

/** 允许透传给上游的请求头。其余一律丢弃，尤其是客户端自带的 Authorization。 */
const FORWARD_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "accept-language",
  "anthropic-version",
]);

/** 允许回传给浏览器的响应头。 */
const FORWARD_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "x-cpa-trace-id",
  "x-request-id",
]);

export async function handleProxy(request: Request, env: Env, subPath: string): Promise<Response> {
  const upstreamBase = (env.UPSTREAM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!upstreamBase || !env.UPSTREAM_API_KEY) {
    return json({ error: "服务端没有配置上游后端" }, 501);
  }

  const target = buildTargetURL(upstreamBase, subPath, new URL(request.url).search);
  if (!target) {
    return json({ error: "非法的代理路径" }, 400);
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  // 客户端传来的 Authorization 已经在上面被过滤掉了，这里换成服务端持有的真 key
  headers.set("Authorization", `Bearer ${env.UPSTREAM_API_KEY}`);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    // 转发流式请求体（上传大文件）时需要
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit);

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
  }
  // SSE 绝不能被缓冲，否则前端要等整个响应结束才看到第一个字
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
    responseHeaders.set("Cache-Control", "no-cache, no-transform");
    responseHeaders.set("X-Accel-Buffering", "no");
  }

  // 直接把 body 交出去，不 await text() —— 这是流式透传的关键
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * 拼上游地址，并确保结果仍然落在配置的上游域名下。
 * 不做这个校验的话，`/__api/proxy/https://evil.com/` 会把 Worker 变成开放代理。
 */
function buildTargetURL(upstreamBase: string, subPath: string, search: string): string | null {
  const clean = subPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  // 绝对 URL 一律拒绝
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return null;

  const base = new URL(upstreamBase);
  const candidate = new URL(`${upstreamBase}/${clean}${search}`);
  if (candidate.origin !== base.origin) return null;
  if (!candidate.pathname.startsWith(base.pathname)) return null;
  return candidate.toString();
}
