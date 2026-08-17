import { firstString, isRecord, parseJSON } from "@/transport/errors";
import { fetchWorkerApi, WorkerAuthorizationError } from "@/transport/worker-access";

export type WebSearchItem = {
  title: string;
  snippet: string;
  url?: string;
  source?: string;
};

export type WebSearchResult = {
  ok: boolean;
  query: string;
  items: WebSearchItem[];
  provider: string;
  error?: string;
};

export type WebSearchRequest = {
  query: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** 调同源 Worker。浏览器只负责工具循环，真实的出网搜索全部留在 Worker。 */
export async function requestWebSearch(options: WebSearchRequest): Promise<WebSearchResult> {
  const body: Record<string, unknown> = { query: options.query };
  // auto 交给 Worker 的环境配置决定；这样部署者设置 SEARCH_PROVIDER 后，
  // 浏览器默认设置不会把它无意覆盖成另一条路由。
  if (options.provider && options.provider !== "auto") body.provider = options.provider;
  if (options.apiKey) body.apiKey = options.apiKey;
  if (options.baseUrl) body.baseUrl = options.baseUrl;
  if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs;

  const response = await fetchWorkerApi("/__api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const responseText = await response.text();
  const payload = parseJSON(responseText);

  if (!response.ok) {
    const message = isRecord(payload) ? firstString(payload.error, payload.message) : "";
    if (response.status === 401) {
      throw new WorkerAuthorizationError("函数搜索未获得 Worker 授权，请在设置的“联网”页验证访问口令");
    }
    throw new Error(message || `搜索接口返回 HTTP ${response.status}`);
  }
  if (!isRecord(payload)) throw new Error("搜索接口返回了无法解析的响应");

  const query = firstString(payload.query) || options.query;
  const provider = firstString(payload.provider) || options.provider || "unknown";
  const items = Array.isArray(payload.items)
    ? payload.items.map(readSearchItem).filter((item): item is WebSearchItem => item !== null).slice(0, 6)
    : [];
  const ok = payload.ok === true && items.length > 0;
  const error = firstString(payload.error);

  return {
    ok,
    query,
    items,
    provider,
    ...(!ok && error ? { error } : {}),
  };
}

function readSearchItem(value: unknown): WebSearchItem | null {
  if (!isRecord(value)) return null;
  const title = firstString(value.title).trim();
  const snippet = firstString(value.snippet).trim();
  if (!title && !snippet) return null;
  const url = readHttpUrl(value.url);
  const source = firstString(value.source).trim();
  return {
    title: title || "搜索结果",
    snippet,
    ...(url ? { url } : {}),
    ...(source ? { source } : {}),
  };
}

function readHttpUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}
