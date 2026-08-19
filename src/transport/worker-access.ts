import { firstString, isRecord, parseJSON } from "@/transport/errors";
import { createRequestTimeoutScope, DEFAULT_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

const TOKEN_STORAGE_KEY = "chatweb:worker-access-token";

let memoryToken = "";

export class WorkerAuthorizationError extends Error {
  constructor(message = "Worker 未授权") {
    super(message);
    this.name = "WorkerAuthorizationError";
  }
}

/**
 * Worker 访问 token 只活在当前标签页。口令仅用于换 token，从不落盘。
 * 内存副本兼容禁用 sessionStorage 的隐私模式。
 */
export function getWorkerAccessToken(): string {
  let token = memoryToken;
  try {
    token = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? token;
  } catch {
    // 隐私模式可能直接拒绝 sessionStorage；继续使用内存副本。
  }

  if (token && tokenExpired(token)) {
    clearWorkerAccessToken();
    return "";
  }
  memoryToken = token;
  return token;
}

export function hasWorkerAccessToken(): boolean {
  return Boolean(getWorkerAccessToken());
}

export function clearWorkerAccessToken(): void {
  memoryToken = "";
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 内存副本已经清掉，无需让存储异常影响请求。
  }
}

/** 用部署者设置的 ACCESS_PASSWORD 换取 12 小时 token。 */
export async function authenticateWorker(password: string, signal?: AbortSignal): Promise<void> {
  if (!password) throw new Error("请输入 Worker 访问口令");

  const request = createRequestTimeoutScope(signal);
  try {
    const response = await request.run(() => fetch("/__api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: request.signal,
    }), DEFAULT_REQUEST_TIMEOUT_MS, "连接 Worker 认证接口");
    const responseText = await request.run(
      () => response.text(),
      DEFAULT_REQUEST_TIMEOUT_MS,
      "读取 Worker 认证响应",
    );
    const payload = parseJSON(responseText);

    if (!response.ok) {
      const message = isRecord(payload) ? firstString(payload.error, payload.message) : "";
      throw new Error(message || `Worker 认证返回 HTTP ${response.status}`);
    }
    const token = isRecord(payload) ? firstString(payload.token) : "";
    if (!token) throw new Error("Worker 认证响应里没有 token");

    memoryToken = token;
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // 当前页面仍可使用内存 token；刷新后需要重新验证。
    }
  } finally {
    request.dispose();
  }
}

/** 调用受保护的同源 Worker API；过期/无效 token 收到 401 后立即清掉。 */
export async function fetchWorkerApi(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getWorkerAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 && token) clearWorkerAccessToken();
  return response;
}

function tokenExpired(token: string): boolean {
  const separator = token.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(token.slice(0, separator));
  return Number.isFinite(expiresAt) && expiresAt <= Math.floor(Date.now() / 1000);
}
