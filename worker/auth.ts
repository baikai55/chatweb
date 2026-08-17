/**
 * 访问口令 → 短期 token。
 *
 * 配好访问控制后，访问者输入口令换取有时效的签名 token，之后用它调
 * /__api/proxy、/__api/upload 和 /__api/search。访问控制可以独立于上游代理启用。
 *
 * 不做明文比对后直接放行 —— 那样每个请求都得再传一次口令。
 */

const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type Env = {
  ASSETS: Fetcher;
  MEDIA?: R2Bucket;
  UPSTREAM_BASE_URL?: string;
  UPSTREAM_NAME?: string;
  UPSTREAM_CAPABILITIES?: string;
  UPSTREAM_API_KEY?: string;
  ACCESS_PASSWORD?: string;
  TOKEN_SECRET?: string;
  MAX_UPLOAD_BYTES?: string;
  MEDIA_CACHE_SECONDS?: string;
  SEARCH_PROVIDER?: string;
  SEARCH_API_KEY?: string;
  SEARCH_BASE_URL?: string;
  SEARCH_TIMEOUT_MS?: string;
};

/** 访问控制独立于代理；只保护搜索/上传时也可以启用。 */
export function isTokenAccessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_PASSWORD && env.TOKEN_SECRET);
}

/** 两项只配了一项也算启用了访问控制，路由必须失败关闭。 */
export function hasTokenAccessSettings(env: Env): boolean {
  return Boolean(env.ACCESS_PASSWORD || env.TOKEN_SECRET);
}

/** 服务端密钥代理是否可用。四样缺一不可。 */
export function isProxyModeConfigured(env: Env): boolean {
  return Boolean(env.UPSTREAM_BASE_URL && env.UPSTREAM_API_KEY && isTokenAccessConfigured(env));
}

export async function issueToken(env: Env, nowSeconds: number): Promise<string> {
  const expiresAt = nowSeconds + TOKEN_TTL_SECONDS;
  const payload = String(expiresAt);
  const signature = await sign(env, payload);
  return `${payload}.${signature}`;
}

export async function verifyToken(env: Env, token: string | null, nowSeconds: number): Promise<boolean> {
  if (!isTokenAccessConfigured(env) || !token) return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt < nowSeconds) return false;

  const expected = await sign(env, payload);
  return timingSafeEqual(signature, expected);
}

async function sign(env: Env, payload: string): Promise<string> {
  const secret = env.TOKEN_SECRET ?? "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(signature));
}

/** 口令比对也走定长比较，避免时序侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function readBearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
