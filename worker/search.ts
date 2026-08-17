import type { Env } from "./auth";
import {
  BodyTooLargeError,
  InvalidJsonBodyError,
  readJsonBodyWithLimit,
  readResponseTextWithLimit,
} from "./body";
import { json } from "./upload";

export type SearchItem = {
  title: string;
  snippet: string;
  url?: string;
  source?: string;
};

export type SearchResult = {
  ok: boolean;
  query: string;
  items: SearchItem[];
  provider: string;
  error?: string;
};

export type WebSearchOptions = {
  query: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_SEARCH_TIMEOUT_MS = 7_000;
const MIN_SEARCH_TIMEOUT_MS = 1_000;
const MAX_SEARCH_TIMEOUT_MS = 15_000;
const MAX_QUERY_LENGTH = 500;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_SEARXNG_URL = "https://searx.be";

const PROVIDERS = new Set([
  "auto",
  "exa",
  "bing",
  "bing-rss",
  "duckduckgo",
  "searxng",
  "tavily",
  "serper",
]);

class SearchUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUrlError";
  }
}

class SearchResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchResponseError";
  }
}

type SearchCandidate = {
  provider: string;
  run: (signal: AbortSignal) => Promise<SearchResult>;
};

type JsonObject = Record<string, unknown>;

/**
 * Worker 搜索入口。路由层只负责校验和读取配置，搜索 key 从不写日志、URL 或错误正文。
 */
export async function handleSearch(request: Request, env: Env): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBodyWithLimit(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json({ error: "搜索请求太大" }, 413);
    if (error instanceof InvalidJsonBodyError) return json({ error: "搜索请求必须是 JSON 对象" }, 400);
    throw error;
  }
  if (!isObject(rawBody)) return json({ error: "搜索请求必须是 JSON 对象" }, 400);
  const body = rawBody;

  const rawQuery = typeof body.query === "string" ? normalizeWhitespace(body.query) : "";
  if (!rawQuery) return json({ error: "搜索词不能为空" }, 400);
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    return json({ error: `搜索词不能超过 ${MAX_QUERY_LENGTH} 个字符` }, 400);
  }
  const query = normalizeSearchQuery(rawQuery);

  const providerValue = body.provider ?? env.SEARCH_PROVIDER ?? "auto";
  if (typeof providerValue !== "string") return json({ error: "搜索服务类型无效" }, 400);
  const provider = providerValue.trim().toLowerCase() || "auto";
  if (!PROVIDERS.has(provider)) {
    return json({ error: "不支持这个搜索服务" }, 400);
  }

  const apiKey = optionalString(body.apiKey, env.SEARCH_API_KEY, 4_096);
  if (apiKey === null) return json({ error: "搜索 API key 无效" }, 400);

  const baseUrl = optionalString(body.baseUrl, env.SEARCH_BASE_URL, 2_048);
  if (baseUrl === null) return json({ error: "搜索接口地址无效" }, 400);

  const timeoutMs = resolveRouteTimeout(body.timeoutMs, env.SEARCH_TIMEOUT_MS);
  const result = await runWebSearch({
    query,
    provider,
    apiKey,
    baseUrl,
    timeoutMs,
    signal: request.signal,
  });
  return json(result);
}

/**
 * 依次尝试搜索服务。auto 会优先使用已配置的付费服务，再退到免费服务。
 * timeoutMs 是整个兜底链路的总预算，外部 signal 取消时也会立即停止。
 */
export async function runWebSearch(options: WebSearchOptions): Promise<SearchResult> {
  const rawQuery = normalizeWhitespace(options.query);
  if (!rawQuery) return failedResult("", "none", "搜索词不能为空");
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    return failedResult(rawQuery.slice(0, MAX_QUERY_LENGTH), "none", `搜索词不能超过 ${MAX_QUERY_LENGTH} 个字符`);
  }
  const query = normalizeSearchQuery(rawQuery);

  const provider = (options.provider ?? "auto").trim().toLowerCase() || "auto";
  if (!PROVIDERS.has(provider)) return failedResult(query, provider, "不支持这个搜索服务");

  const apiKey = (options.apiKey ?? "").trim();
  const baseUrl = (options.baseUrl ?? "").trim();
  const candidates = buildCandidates(provider, query, apiKey, baseUrl);
  if (candidates.length === 0) {
    const error = provider === "tavily" || provider === "serper"
      ? "这个搜索服务需要 API key"
      : "没有可用的搜索服务";
    return failedResult(query, provider, error);
  }

  const scope = createSearchScope(options.signal, clampSearchTimeout(options.timeoutMs));
  let last = failedResult(query, provider, "搜索服务没有返回可用结果");

  try {
    for (const candidate of candidates) {
      if (scope.signal.aborted) break;
      try {
        const result = await candidate.run(scope.signal);
        last = result;
        if (result.ok && result.items.length > 0) return result;
      } catch (error) {
        if (scope.signal.aborted) break;
        last = failedResult(query, candidate.provider, safeErrorMessage(error));
      }
    }

    if (scope.signal.aborted) {
      return failedResult(query, last.provider, scope.didTimeout() ? "搜索超时" : "搜索已取消");
    }
    return last;
  } finally {
    scope.cleanup();
  }
}

/** 只允许公网 http(s) 地址；每次请求及每一跳重定向都会执行此校验。 */
export function assertSafeSearchUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SearchUrlError("搜索接口地址无效");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SearchUrlError("搜索接口只允许 http:// 或 https:// 地址");
  }
  if (url.username || url.password) {
    throw new SearchUrlError("搜索接口地址不能包含用户名或密码");
  }

  const host = normalizeHostname(url.hostname);
  if (!host || isBlockedHostname(host) || isBlockedIpLiteral(host)) {
    throw new SearchUrlError("搜索接口不能指向本机、局域网或保留地址");
  }
  return url.toString();
}

export function clampSearchTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SEARCH_TIMEOUT_MS;
  return Math.min(MAX_SEARCH_TIMEOUT_MS, Math.max(MIN_SEARCH_TIMEOUT_MS, Math.round(value)));
}

function buildCandidates(provider: string, query: string, apiKey: string, baseUrl: string): SearchCandidate[] {
  const searxUrl = baseUrl || DEFAULT_SEARXNG_URL;

  if (provider === "tavily") {
    return apiKey ? [{ provider: "tavily", run: (signal) => searchTavily(query, apiKey, signal) }] : [];
  }
  if (provider === "serper") {
    return apiKey ? [{ provider: "serper", run: (signal) => searchSerper(query, apiKey, signal) }] : [];
  }
  if (provider === "exa") {
    return [{ provider: "exa", run: (signal) => searchExaMcp(query, signal) }];
  }
  if (provider === "searxng") {
    return [{ provider: "searxng", run: (signal) => searchSearxng(query, searxUrl, signal) }];
  }
  if (provider === "bing" || provider === "bing-rss") {
    return [{ provider: "bing-rss", run: (signal) => searchBingRss(query, signal) }];
  }
  if (provider === "duckduckgo") {
    return [{ provider: "duckduckgo", run: (signal) => searchDuckDuckGo(query, signal) }];
  }

  const candidates: SearchCandidate[] = [];
  if (apiKey) {
    if (/^tvly-/i.test(apiKey)) {
      candidates.push({ provider: "tavily", run: (signal) => searchTavily(query, apiKey, signal) });
    } else {
      candidates.push({ provider: "serper", run: (signal) => searchSerper(query, apiKey, signal) });
    }
  }
  candidates.push({ provider: "exa", run: (signal) => searchExaMcp(query, signal) });
  candidates.push({ provider: "bing-rss", run: (signal) => searchBingRss(query, signal) });
  candidates.push({ provider: "searxng", run: (signal) => searchSearxng(query, searxUrl, signal) });
  candidates.push({ provider: "duckduckgo", run: (signal) => searchDuckDuckGo(query, signal) });
  return candidates;
}

/** 与 OpenCode 的 websearch 一样，直接调用匿名 Exa MCP 执行通用网页搜索。 */
async function searchExaMcp(query: string, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetchSafe("https://mcp.exa.ai/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "chatweb/0.1",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          type: "auto",
          numResults: 6,
          livecrawl: "fallback",
          contextMaxCharacters: 8_000,
        },
      },
    }),
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "exa", response.status);
  }

  const responseText = await readSearchResponseText(response);
  const toolText = readMcpToolText(responseText);
  if (!toolText) return failedResult(query, "exa", "Exa 没有返回可用结果");

  const blocks = toolText.split(/\n\s*---\s*\n/g);
  const items: SearchItem[] = [];
  for (const block of blocks) {
    const title = firstLineValue(block, "Title") || "Exa 搜索结果";
    const resultUrl = sanitizeResultUrl(firstLineValue(block, "URL"));
    const highlightsAt = block.search(/^Highlights:\s*$/m);
    const snippetSource = highlightsAt >= 0
      ? block.slice(highlightsAt).replace(/^Highlights:\s*/m, "")
      : block.replace(/^(?:Title|URL|Published|Author):.*$/gm, "");
    const snippet = truncate(snippetSource.replace(/^\.\.\.\s*$/gm, " "), 520);
    if (!snippet && !resultUrl) continue;
    items.push({
      title: truncate(title, 120),
      snippet,
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "exa",
    });
    if (items.length >= 6) break;
  }
  return resultFromItems(query, "exa", items);
}

function readMcpToolText(body: string): string {
  const payloads = body.trimStart().startsWith("{")
    ? [body.trim()]
    : body.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6).trim());

  for (const payload of payloads) {
    if (!payload || payload === "[DONE]") continue;
    try {
      const root = asObject(JSON.parse(payload));
      const result = asObject(root?.result);
      for (const rawContent of asArray(result?.content)) {
        const content = asObject(rawContent);
        const text = asString(content?.text).trim();
        if (text) return text;
      }
    } catch {
      // 忽略不是 JSON 的 SSE 行，继续寻找下一条 data 帧。
    }
  }
  return "";
}

function firstLineValue(block: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(block);
  return match?.[1]?.trim() ?? "";
}

async function searchBingRss(query: string, signal: AbortSignal): Promise<SearchResult> {
  const url = new URL("https://cn.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  const response = await fetchSafe(url.toString(), {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml",
      "user-agent": "Mozilla/5.0 chatweb/0.1",
    },
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "bing-rss", response.status);
  }

  const xml = await readSearchResponseText(response);
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const items: SearchItem[] = [];
  for (const block of blocks.slice(0, 6)) {
    const title = cleanMarkup(matchXmlTag(block, "title") || "结果");
    const snippet = cleanMarkup(matchXmlTag(block, "description"));
    const resultUrl = sanitizeResultUrl(decodeEntities(matchXmlTag(block, "link")));
    if (!title && !snippet) continue;
    items.push({
      title: truncate(title, 100),
      snippet: truncate(snippet, 260),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "bing-rss",
    });
  }
  return resultFromItems(query, "bing-rss", items);
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchResult> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  const response = await fetchSafe(url.toString(), {
    headers: { accept: "application/json", "user-agent": "chatweb/0.1" },
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "duckduckgo", response.status);
  }

  const data = asObject(await readSearchResponseJson(response));
  const items: SearchItem[] = [];
  const abstract = asString(data?.AbstractText);
  if (abstract) {
    const resultUrl = sanitizeResultUrl(asString(data?.AbstractURL));
    items.push({
      title: truncate(cleanMarkup(asString(data?.Heading) || "摘要"), 100),
      snippet: truncate(cleanMarkup(abstract), 280),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "duckduckgo-abstract",
    });
  }

  for (const rawTopic of asArray(data?.RelatedTopics)) {
    const topic = asObject(rawTopic);
    const nested = asArray(topic?.Topics);
    const topicList = nested.length > 0 ? nested : [rawTopic];
    for (const rawItem of topicList) {
      const item = asObject(rawItem);
      const text = cleanMarkup(asString(item?.Text));
      if (!text) continue;
      const resultUrl = sanitizeResultUrl(asString(item?.FirstURL));
      items.push({
        title: truncate(text.split(" - ")[0] || text, 100),
        snippet: truncate(text, 240),
        ...(resultUrl ? { url: resultUrl } : {}),
        source: "duckduckgo-related",
      });
      if (items.length >= 6) break;
    }
    if (items.length >= 6) break;
  }
  return resultFromItems(query, "duckduckgo", items.slice(0, 6));
}

async function searchSearxng(query: string, baseUrl: string, signal: AbortSignal): Promise<SearchResult> {
  const safeBase = new URL(assertSafeSearchUrl(baseUrl));
  const basePath = safeBase.pathname.replace(/\/+$/, "");
  safeBase.pathname = basePath.endsWith("/search") ? basePath : `${basePath}/search`;
  safeBase.search = "";
  safeBase.hash = "";
  safeBase.searchParams.set("q", query);
  safeBase.searchParams.set("format", "json");
  safeBase.searchParams.set("language", "zh-CN");

  const response = await fetchSafe(safeBase.toString(), {
    headers: { accept: "application/json", "user-agent": "chatweb/0.1" },
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "searxng", response.status);
  }

  const data = asObject(await readSearchResponseJson(response));
  const items: SearchItem[] = [];
  for (const rawItem of asArray(data?.results).slice(0, 6)) {
    const item = asObject(rawItem);
    if (!item) continue;
    const title = cleanMarkup(asString(item.title) || "结果");
    const snippet = cleanMarkup(asString(item.content) || asString(item.snippet));
    if (!title && !snippet) continue;
    const resultUrl = sanitizeResultUrl(asString(item.url));
    items.push({
      title: truncate(title, 100),
      snippet: truncate(snippet, 260),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "searxng",
    });
  }
  return resultFromItems(query, "searxng", items);
}

async function searchTavily(query: string, apiKey: string, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetchSafe("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: 5,
    }),
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "tavily", response.status);
  }

  const data = asObject(await readSearchResponseJson(response));
  const items: SearchItem[] = [];
  const answer = cleanMarkup(asString(data?.answer));
  if (answer) items.push({ title: "综合摘要", snippet: truncate(answer, 320), source: "tavily-answer" });

  for (const rawItem of asArray(data?.results)) {
    const item = asObject(rawItem);
    if (!item) continue;
    const resultUrl = sanitizeResultUrl(asString(item.url));
    items.push({
      title: truncate(cleanMarkup(asString(item.title) || "结果"), 100),
      snippet: truncate(cleanMarkup(asString(item.content)), 260),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "tavily",
    });
    if (items.length >= 6) break;
  }
  return resultFromItems(query, "tavily", items.slice(0, 6));
}

async function searchSerper(query: string, apiKey: string, signal: AbortSignal): Promise<SearchResult> {
  const response = await fetchSafe("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 5 }),
  }, signal);
  if (!response.ok) {
    await discardResponseBody(response);
    return httpFailure(query, "serper", response.status);
  }

  const data = asObject(await readSearchResponseJson(response));
  const items: SearchItem[] = [];
  const answerBox = asObject(data?.answerBox);
  const answer = cleanMarkup(asString(answerBox?.answer) || asString(answerBox?.snippet));
  if (answer) {
    const resultUrl = sanitizeResultUrl(asString(answerBox?.link));
    items.push({
      title: truncate(cleanMarkup(asString(answerBox?.title) || "直达答案"), 100),
      snippet: truncate(answer, 280),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "serper-answer",
    });
  }

  for (const rawItem of asArray(data?.organic)) {
    const item = asObject(rawItem);
    if (!item) continue;
    const resultUrl = sanitizeResultUrl(asString(item.link));
    items.push({
      title: truncate(cleanMarkup(asString(item.title) || "结果"), 100),
      snippet: truncate(cleanMarkup(asString(item.snippet)), 260),
      ...(resultUrl ? { url: resultUrl } : {}),
      source: "serper",
    });
    if (items.length >= 6) break;
  }
  return resultFromItems(query, "serper", items.slice(0, 6));
}

async function fetchSafe(rawUrl: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let currentUrl = assertSafeSearchUrl(rawUrl);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
      signal,
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location) return response;
    await discardResponseBody(response);
    if (redirectCount === 3) throw new SearchUrlError("搜索接口重定向次数过多");

    const nextUrl = assertSafeSearchUrl(new URL(location, currentUrl).toString());
    const carriesSecret = Boolean(body) || headers.has("x-api-key") || headers.has("authorization");
    if (carriesSecret && new URL(nextUrl).origin !== new URL(currentUrl).origin) {
      throw new SearchUrlError("搜索接口不能携带密钥跨域重定向");
    }
    currentUrl = nextUrl;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("content-type");
      headers.delete("content-length");
    }
  }

  throw new SearchUrlError("搜索接口重定向次数过多");
}

function createSearchScope(externalSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = (): void => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function resolveRouteTimeout(value: unknown, envValue: string | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return clampSearchTimeout(value);
  const parsedEnv = Number(envValue);
  return clampSearchTimeout(Number.isFinite(parsedEnv) ? parsedEnv : undefined);
}

function optionalString(value: unknown, fallback: string | undefined, maxLength: number): string | null {
  const resolved = value === undefined ? fallback ?? "" : value;
  if (typeof resolved !== "string" || resolved.length > maxLength) return null;
  return resolved.trim();
}

function normalizeWhitespace(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
}

export function normalizeSearchQuery(value: unknown): string {
  return normalizeWhitespace(value);
}

function resultFromItems(query: string, provider: string, items: SearchItem[]): SearchResult {
  const uniqueItems = deduplicateSearchItems(items);
  return uniqueItems.length > 0
    ? { ok: true, query, items: uniqueItems, provider }
    : failedResult(query, provider, "搜索服务没有返回可用结果");
}

function deduplicateSearchItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.url?.toLocaleLowerCase() || `${item.title}\n${item.snippet}`.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function failedResult(query: string, provider: string, error: string): SearchResult {
  return { ok: false, query, items: [], provider, error };
}

function httpFailure(query: string, provider: string, status: number): SearchResult {
  return failedResult(query, provider, `搜索服务返回 HTTP ${status}`);
}

/** 只返回我们生成的固定错误，不透传可能含 key 的异常或上游响应正文。 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof SearchUrlError || error instanceof SearchResponseError) return error.message;
  return "搜索服务请求失败";
}

async function readSearchResponseText(response: Response): Promise<string> {
  try {
    return await readResponseTextWithLimit(response, MAX_SEARCH_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new SearchResponseError("搜索服务响应太大");
    throw new SearchResponseError("搜索服务返回的数据无效");
  }
}

async function readSearchResponseJson(response: Response): Promise<unknown> {
  const text = await readSearchResponseText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SearchResponseError("搜索服务返回的数据无效");
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body || response.body.locked) return;
  await response.body.cancel().catch(() => undefined);
}

function matchXmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match?.[1] ?? "";
}

function cleanMarkup(value: string): string {
  return decodeEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => safeCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => safeCodePoint(Number.parseInt(digits, 16)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "";
  return String.fromCodePoint(value);
}

function truncate(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function sanitizeResultUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/\.$/, "");
}

function isBlockedHostname(host: string): boolean {
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".lan")
    || host.endsWith(".home.arpa");
}

function isBlockedIpLiteral(host: string): boolean {
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  if (ipv6.every((byte) => byte === 0)) return true;
  if (ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1) return true;
  if ((ipv6[0] & 0xfe) === 0xfc) return true;
  if (ipv6[0] === 0xfe) return true;
  if (ipv6[0] === 0xff) return true;
  if (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8) return true;

  const isIpv4Mapped = ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
  const isIpv4Compatible = ipv6.slice(0, 12).every((byte) => byte === 0);
  return (isIpv4Mapped || isIpv4Compatible) && isBlockedIpv4(ipv6.slice(12));
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function isBlockedIpv4(bytes: number[]): boolean {
  const [a = -1, b = -1, c = -1] = bytes;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let source = host;
  const embeddedIpv4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(source);
  if (embeddedIpv4) {
    const bytes = parseIpv4(embeddedIpv4[1]);
    if (!bytes) return null;
    const replacement = `${((bytes[0] ?? 0) << 8 | (bytes[1] ?? 0)).toString(16)}:${((bytes[2] ?? 0) << 8 | (bytes[3] ?? 0)).toString(16)}`;
    source = source.slice(0, source.length - embeddedIpv4[1].length) + replacement;
  }

  if ((source.match(/::/g) ?? []).length > 1) return null;
  const [leftText, rightText] = source.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;

  const missing = 8 - left.length - right.length;
  if (source.includes("::") ? missing < 1 : missing !== 0) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
