/**
 * 错误解析。
 *
 * 几个后端的错误体形状互不相同，而且都不完全符合 OpenAI 规范：
 *
 *   CPA          {"error": "Missing API key"}          ← error 是字符串，不是对象
 *   OpenAI 标准  {"error": {"message", "type", "code"}}
 *   grok2api     {"error": {"code", "message", "requestId"}}
 *   chatgpt2api  {"detail": {"error": "..."}}          ← FastAPI 风格
 *   裸消息        {"message": "..."}
 *
 * 这个模块把它们都收敛成 TransportError。
 */

export class TransportError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(status: number, message: string, code?: string, requestId?: string) {
    super(message);
    this.name = "TransportError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJSON(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

type ParsedError = { code?: string; message?: string; requestId?: string };

/** 从任意形状的错误体里挖出 code / message / requestId。 */
export function readError(payload: unknown): ParsedError {
  if (typeof payload === "string") {
    return payload.trim() ? { message: payload.trim() } : {};
  }
  if (!isRecord(payload)) return {};

  // FastAPI 的 {"detail": ...} 先剥一层
  const unwrapped = "detail" in payload && !("error" in payload) ? payload.detail : payload;
  if (typeof unwrapped === "string") {
    return unwrapped.trim() ? { message: unwrapped.trim() } : {};
  }
  if (!isRecord(unwrapped)) return {};

  const raw = unwrapped.error;

  // CPA 的 {"error": "字符串"}
  if (typeof raw === "string") {
    return { message: raw.trim() || undefined };
  }

  // 标准的 {"error": {...}}，或者错误字段直接铺在顶层
  const source = isRecord(raw) ? raw : unwrapped;
  const message = firstString(source.message, source.error, source.detail, source.msg);
  const code = firstString(source.code, source.type);
  const requestId = firstString(source.requestId, source.request_id, source.trace_id);

  return {
    message: message || undefined,
    code: code || undefined,
    requestId: requestId || undefined,
  };
}

/**
 * 把一个失败的 Response 转成 TransportError。
 * 已经读过 body 的调用方可以把文本传进来，避免重复消费 stream。
 */
export function toTransportError(response: Response, responseText: string): TransportError {
  const payload = parseJSON(responseText);
  const parsed = readError(payload);
  const fallback = responseText.trim() || response.statusText || `HTTP ${response.status}`;
  const message = parsed.message ?? fallback;
  const requestId = parsed.requestId ?? response.headers.get("X-CPA-Trace-Id") ?? response.headers.get("X-Request-ID") ?? undefined;
  return new TransportError(response.status, annotate(response.status, message, responseText), parsed.code, requestId);
}

/**
 * 给几个用户看了会一头雾水的错误补充解释。
 *
 * 最典型的是 CPA 的 safe-mode：config.yaml 里还是 `your-api-key-1` 这种模板值时，
 * 所有 /v1 路径直接 403，用户会以为是自己的 key 填错了，其实是服务端没配好。
 */
function annotate(status: number, message: string, rawBody: string): string {
  const haystack = `${message} ${rawBody}`.toLowerCase();

  if (haystack.includes("unsafe_example_api_key")) {
    return `${message}\n\n这是服务端配置问题，不是你的 key 有问题：CPA 的 config.yaml 里 api-keys 还是示例模板值（如 your-api-key-1），触发了安全模式，所有 /v1 路径都被拦截。需要在 CPA 侧填入真实的 key 并重载。`;
  }
  if (status === 401) {
    return `${message}\n\nkey 没通过验证。检查设置里的 API Key 是否正确，以及后端是否已经重载了新加的 key。`;
  }
  if (status === 404) {
    return `${message}\n\n这个后端没有这个端点。可能是能力探测的结果过期了，去设置里重新探测一次。`;
  }
  if (status === 429) {
    return `${message}\n\n上游限流了，等一会儿再试。`;
  }
  return message;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
