import { joinURL } from "@/transport/url";
import { isAbortError, isRecord, toTransportError, firstString } from "@/transport/errors";
import { createRequestTimeoutScope, DEFAULT_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";
import { STORE_MODEL_CACHE, idbGet, idbPut } from "@/shared/db/idb";
import { BACKEND_FLAVORS, type Backend, type BackendFlavor, type ModelKind } from "@/backends/types";

/**
 * 模型目录。
 *
 * CPA 的 /v1/models 被显式砍到只剩 id / object / created / owned_by 四个字段
 * （openai_handlers.go:70-89 有一行注释直说了"Filter to only include the 4 required fields"）。
 * 内部注册表其实持有 Thinking 和 SupportsWebSearch，但三个 convertModelToMap
 * 分支没有一个把它们输出。所以能力矩阵只能前端自维护。
 *
 * 不过有两个端点能白捡一些元数据，用来做显示名和上下文窗口展示：
 *   GET /models 带 Anthropic-Version 头  → display_name / max_input_tokens / max_tokens
 *   GET /v1beta/models                   → displayName / inputTokenLimit / outputTokenLimit
 */

export type CatalogModel = {
  id: string;
  ownedBy: string;
  /** 推断或用户指定的归类 */
  kind: Exclude<ModelKind, "auto">;
  /** 归类是用户手动指定的，而非推断 */
  overridden: boolean;
  /** 是否推理模型 —— 决定要不要显示推理档位选择器和推理过程折叠区 */
  reasoning: boolean;
  vendor: string;
  displayName?: string;
  contextWindow?: number;
  /** 用户勾选保存过。聊天选择器默认只显示这些。 */
  saved: boolean;
};

type CachedCatalog = {
  backendId: string;
  fetchedAt: number;
  /** 缓存时的地址。用户改了地址就得重拉，旧记录没这个字段也一样重拉 */
  baseURL?: string;
  /** 从这次请求的响应头认出来的后端方言 */
  flavor?: BackendFlavor;
  /** 只缓存从网络拿到的原始信息，saved / kind 这些依赖当前配置的字段每次重算 */
  rows: Array<{ id: string; ownedBy: string; displayName?: string; contextWindow?: number }>;
};

/** 拉模型时白捡的东西：既有列表，也有响应头暴露的方言。 */
export type ModelCatalog = {
  models: CatalogModel[];
  flavor: BackendFlavor;
  fetchedAt: number;
};

/** React Query 与手动刷新共用同一个稳定 key；不把原始密钥放进 key。 */
export function modelCatalogQueryKey(backend: Pick<Backend, "id" | "baseURL">) {
  return ["models", backend.id, backend.baseURL] as const;
}

/** 缓存多久之内算新鲜。只用来提示"这份可能过期了"，不再自动重拉。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function isCatalogStale(fetchedAt: number): boolean {
  return Date.now() - fetchedAt > CACHE_TTL_MS;
}

/**
 * 读本地缓存的模型目录，**不打网络**。没有缓存时返回 null。
 *
 * 进页面不自动拉取是刻意的：所有出网请求都由用户点出来。
 * 拉取用 `refreshModelCatalog()`，设置页有「获取模型」按钮。
 */
export async function readModelCatalog(backend: Backend): Promise<ModelCatalog | null> {
  const cached = await readCache(backend.id);
  if (!cached || cached.baseURL !== backend.baseURL) return null;
  return {
    models: decorate(cached.rows, backend),
    flavor: cached.flavor ?? backend.flavor,
    fetchedAt: cached.fetchedAt,
  };
}

/**
 * 打网络拉模型目录并写缓存。
 *
 * 一次调用实际是三个请求（`/models` 加两个富字段端点），所以只在用户点
 * 「获取模型」时才发 —— 模型列表本来也不常变。
 */
export async function refreshModelCatalog(
  backend: Backend,
  signal?: AbortSignal,
): Promise<ModelCatalog> {
  const { rows, flavor } = await fetchFromNetwork(backend, signal);
  const fetchedAt = Date.now();
  await writeCache({ backendId: backend.id, fetchedAt, baseURL: backend.baseURL, flavor, rows });
  return { models: decorate(rows, backend), flavor, fetchedAt };
}

/**
 * 用当前后端配置重新标注一份已有目录，不打网络。
 *
 * 勾选、改归类这些只影响标注，不影响网络数据。所以这些字段**不该进 query key**
 * —— 进了就等于每勾一下都算一个新查询，列表会整段换成 loading 再挂回来，
 * 滚动位置直接丢。标注在外面这一层重算。
 */
export function applyBackendConfig(models: CatalogModel[], backend: Backend): CatalogModel[] {
  return decorate(models, backend);
}

/**
 * 设置页用的顺序：只按提供商和 id 排，勾选与否不影响位置。
 *
 * 那里是一边扫一边勾，列表不该在手底下动 —— "已保存的排最前"只对模型选择器有意义。
 */
export function sortForBrowsing(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => {
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor, "zh-CN");
    return a.id.localeCompare(b.id, "zh-CN");
  });
}

async function fetchFromNetwork(
  backend: Backend,
  signal?: AbortSignal,
): Promise<{ rows: CachedCatalog["rows"]; flavor: BackendFlavor }> {
  const headers = new Headers({ Accept: "application/json" });
  if (backend.apiKey) headers.set("Authorization", `Bearer ${backend.apiKey}`);

  const request = createRequestTimeoutScope(signal);
  try {
    const response = await request.run(() => fetch(joinURL(backend.baseURL, "/models"), {
      method: "GET",
      headers,
      signal: request.signal,
    }), DEFAULT_REQUEST_TIMEOUT_MS, "连接模型目录接口");
    if (!response.ok) {
      const responseText = await request.run(
        () => response.text(),
        DEFAULT_REQUEST_TIMEOUT_MS,
        "读取模型目录错误响应",
      );
      throw toTransportError(response, responseText);
    }

    const flavor = readFlavor(response.headers);
    const payload = await request.run(
      () => response.json(),
      DEFAULT_REQUEST_TIMEOUT_MS,
      "读取模型目录响应",
    );
    const raw = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const enrichment = await fetchEnrichment(backend, signal);

    const rows = raw.flatMap((row) => {
      if (!isRecord(row)) return [];
      const id = firstString(row.id);
      if (!id) return [];
      const extra = enrichment.get(id);
      return [{
        id,
        ownedBy: firstString(row.owned_by) || "unknown",
        displayName: extra?.displayName,
        contextWindow: extra?.contextWindow,
      }];
    });

    return { rows, flavor };
  } finally {
    request.dispose();
  }
}

/**
 * 后端方言识别。用响应头，不猜。
 *
 * CPA 把 X-CPA-* 全放进了 Access-Control-Expose-Headers，所以浏览器读得到。
 * X-Request-ID 不能用于识别 grok2api：OpenAI 官方和大量兼容网关同样返回它。
 * 无法确定时保留 generic，让语音 auto 使用覆盖面更广的 OpenAI Audio；
 * grok2api 原生端点仍可在语音设置里显式选择。
 */
export function readFlavor(headers: Headers): BackendFlavor {
  if (headers.get("X-CPA-Version") || headers.get("x-cpa-trace-id")) return "cpa";
  // 兜底：有些部署可能不回版本头，看 expose 列表里有没有 X-CPA
  if ((headers.get("Access-Control-Expose-Headers") ?? "").toLowerCase().includes("x-cpa")) return "cpa";
  return "generic";
}

/** 把网络数据和当前后端配置（保存列表、归类覆盖）合成最终的展示模型。 */
function decorate(rows: CachedCatalog["rows"], backend: Backend): CatalogModel[] {
  const saved = new Set(backend.savedModels);

  const models = rows.map((row): CatalogModel => {
    const override = backend.modelOverrides[row.id];
    return {
      id: row.id,
      ownedBy: row.ownedBy,
      kind: override && override !== "auto" ? override : classifyModel(row.id),
      overridden: Boolean(override && override !== "auto"),
      reasoning: isReasoningModel(row.id),
      vendor: inferVendorTag(row.id),
      displayName: row.displayName,
      contextWindow: row.contextWindow,
      saved: saved.has(row.id),
    };
  });

  return sortModels(models, backend.savedModels);
}

async function readCache(backendId: string): Promise<CachedCatalog | undefined> {
  try {
    const cached = await idbGet<unknown>(STORE_MODEL_CACHE, backendId);
    return isCachedCatalog(cached, backendId) ? cached : undefined;
  } catch {
    return undefined;
  }
}

function isCachedCatalog(value: unknown, backendId: string): value is CachedCatalog {
  if (!isRecord(value) || value.backendId !== backendId) return false;
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return false;
  if (value.baseURL !== undefined && typeof value.baseURL !== "string") return false;
  if (
    value.flavor !== undefined
    && (typeof value.flavor !== "string" || !BACKEND_FLAVORS.includes(value.flavor as BackendFlavor))
  ) return false;
  return Array.isArray(value.rows) && value.rows.every((row) => (
    isRecord(row)
    && typeof row.id === "string"
    && typeof row.ownedBy === "string"
    && (row.displayName === undefined || typeof row.displayName === "string")
    && (row.contextWindow === undefined
      || (typeof row.contextWindow === "number" && Number.isFinite(row.contextWindow)))
  ));
}

async function writeCache(entry: CachedCatalog): Promise<void> {
  try {
    await idbPut(STORE_MODEL_CACHE, entry);
  } catch {
    // 缓存写不进去不影响功能，下次重新请求就是了
  }
}


/**
 * 按模型 id 推断归类。
 *
 * CPA 聚合的是各家第三方的原始命名，格式完全不统一 —— 实测里同时存在
 * `grok-imagine-video`、`Nano Banana Pro`、`Gemini 2.5 Flash Preview TTS`
 * 这三种风格。所以匹配前先归一化分隔符：小写 + 空格/下划线/斜杠都转成连字符。
 * 这样 "Nano Banana Pro" → "nano-banana-pro"，一条 `nano-banana` 规则就够了。
 *
 * ⚠️ 顺序敏感，video 必须在 image 之前 ——
 * 否则 `grok-imagine-video` 会被 image 规则里的 `imagine` 抢先匹配成图片模型。
 */
const CLASSIFY_RULES: Array<{ kind: Exclude<ModelKind, "auto">; patterns: string[] }> = [
  { kind: "hidden", patterns: ["embed", "rerank", "moderation"] },
  { kind: "video", patterns: ["veo", "sora", "kling", "runway", "hailuo", "seedance", "-video", "wan2", "wanx"] },
  {
    kind: "image",
    patterns: [
      "dall-e", "dalle", "flux", "imagen", "stable-diffusion", "sd3", "sdxl",
      "gpt-image", "seedream", "nano-banana", "midjourney", "imagine-image", "-image",
    ],
  },
  {
    kind: "stt",
    // stt 放在 tts 之前：`grok-stt` 不含 tts 关键词，但把顺序写明确省得以后加规则时踩坑
    patterns: [
      "whisper", "transcribe", "-stt", "stt-", "-asr", "asr-",
      // 硅基流动当前两款 ASR 的模型 id 分别没有标准 `-asr` 分隔符：
      // FunAudioLLM/SenseVoiceSmall、TeleAI/TeleSpeechASR。
      "sensevoice", "speechasr",
    ],
  },
  {
    kind: "tts",
    // lyria 是 Google 的音乐生成，归到语音面板比归到聊天合理
    patterns: ["tts", "-voice", "voice-", "speech", "elevenlabs", "native-audio", "audio-preview", "lyria", "-live"],
  },
];

export function classifyModel(modelId: string): Exclude<ModelKind, "auto"> {
  const id = normalizeModelId(modelId);
  for (const rule of CLASSIFY_RULES) {
    if (rule.patterns.some((pattern) => id.includes(pattern))) return rule.kind;
  }
  return "chat";
}

/** 归一化分隔符，让同一条规则能同时命中 `nano-banana` 和 `Nano Banana`。 */
export function normalizeModelId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replaceAll(/[\s_/]+/g, "-")
    .replaceAll(/-+/g, "-");
}

const REASONING_PATTERNS = ["-think", "-reasoner", "-reasoning", "deepseek-r", "qwq", "gemini-2.5", "gemini-3", "o1-", "o3-", "o4-"];

export function isReasoningModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  // 必须先排除显式的非推理变体 —— grok2api 有 `grok-4.20-0309-non-reasoning`，
  // 它包含 "-reasoning" 但恰恰是关闭推理的那一档，直接匹配会反向误报。
  if (id.includes("non-reasoning") || id.includes("no-think") || id.includes("non-think")) return false;
  if (REASONING_PATTERNS.some((pattern) => id.includes(pattern))) return true;
  return /^o[134](-|$)/.test(id);
}


/** CPA 的模型 id 默认无前缀，只能靠子串猜提供商。 */
export function inferVendorTag(modelId: string): string {
  const id = normalizeModelId(modelId);
  if (id.includes("claude")) return "Claude";
  if (id.includes("gemini") || id.includes("imagen") || id.includes("veo") || id.includes("nano-banana") || id.includes("lyria")) return "Gemini";
  if (id.includes("grok")) return "Grok";
  if (id.includes("kimi")) return "Kimi";
  if (id.includes("deepseek")) return "DeepSeek";
  if (id.includes("qwen") || id.includes("qwq")) return "Qwen";
  if (id.includes("glm") || id.includes("z-ai")) return "GLM";
  if (id.includes("minimax")) return "MiniMax";
  if (id.includes("nemotron") || id.includes("llama")) return "NVIDIA";
  if (id.includes("codex")) return "Codex";
  if (id.includes("gpt") || id.includes("chatgpt") || /^o[134]/.test(id)) return "OpenAI";
  return "其它";
}

type Enrichment = { displayName?: string; contextWindow?: number };

/**
 * 蹭两个富字段端点。任一失败都无所谓 —— 这些字段纯粹是锦上添花。
 *
 * 注意 supportedInputModalities 虽然在 /v1beta/models 的响应结构里，
 * 但 CPA 内置目录（models.json）里一条都没有，别指望靠它判断是否支持图片输入。
 */
async function fetchEnrichment(backend: Backend, signal?: AbortSignal): Promise<Map<string, Enrichment>> {
  const result = new Map<string, Enrichment>();

  const [anthropicRows, betaRows] = await Promise.all([
    tryFetchRows(joinURL(backend.baseURL, "/models"), backend.apiKey, { "Anthropic-Version": "2023-06-01" }, signal),
    tryFetchRows(deriveBetaURL(backend.baseURL), backend.apiKey, {}, signal),
  ]);

  for (const row of anthropicRows) {
    const id = firstString(row.id);
    if (!id) continue;
    result.set(id, {
      displayName: firstString(row.display_name) || undefined,
      contextWindow: readNumber(row.max_input_tokens),
    });
  }

  for (const row of betaRows) {
    // Gemini 格式的 name 是 "models/xxx"
    const id = firstString(row.name).replace(/^models\//, "");
    if (!id) continue;
    const existing = result.get(id) ?? {};
    result.set(id, {
      displayName: existing.displayName ?? (firstString(row.displayName) || undefined),
      contextWindow: existing.contextWindow ?? readNumber(row.inputTokenLimit),
    });
  }

  return result;
}

async function tryFetchRows(
  url: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const request = createRequestTimeoutScope(signal);
  try {
    const headers = new Headers({ Accept: "application/json", ...extraHeaders });
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    const response = await request.run(() => fetch(url, {
      method: "GET",
      headers,
      signal: request.signal,
    }), DEFAULT_REQUEST_TIMEOUT_MS, "连接模型元数据接口");
    if (!response.ok) return [];
    const payload = await request.run(
      () => response.json(),
      DEFAULT_REQUEST_TIMEOUT_MS,
      "读取模型元数据响应",
    );
    if (!isRecord(payload)) return [];
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    return rows.filter(isRecord);
  } catch (caught) {
    if (signal?.aborted || isAbortError(caught)) throw caught;
    return [];
  } finally {
    request.dispose();
  }
}

/** https://host/v1 → https://host/v1beta */
function deriveBetaURL(baseURL: string): string {
  return baseURL.replace(/\/v1$/i, "/v1beta");
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 保存过的排最前（按保存顺序），其余按提供商和 id 排。 */
function sortModels(models: CatalogModel[], savedOrder: string[]): CatalogModel[] {
  const savedIndex = new Map(savedOrder.map((id, index) => [id, index]));
  return [...models].sort((a, b) => {
    const aSaved = savedIndex.get(a.id);
    const bSaved = savedIndex.get(b.id);
    if (aSaved !== undefined && bSaved !== undefined) return aSaved - bSaved;
    if (aSaved !== undefined) return -1;
    if (bSaved !== undefined) return 1;
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor, "zh-CN");
    return a.id.localeCompare(b.id, "zh-CN");
  });
}

/**
 * 聊天选择器用的候选列表：只有用户勾选保存过的。
 *
 * 不做"没保存就显示全部"的降级 —— 那样用户分不清眼前这一长串是自己选的
 * 还是系统兜底给的。一个都没保存时由 UI 给出明确提示，让用户去设置里挑。
 */
export function savedModelsOnly(models: CatalogModel[]): CatalogModel[] {
  return models.filter((model) => model.saved);
}


/** 按面板筛选。hidden 的永远不出现。 */
export function modelsForKind(models: CatalogModel[], kind: "chat" | "image" | "video" | "voice"): CatalogModel[] {
  if (kind === "voice") return models.filter((model) => model.kind === "tts" || model.kind === "stt");
  return models.filter((model) => model.kind === kind);
}
