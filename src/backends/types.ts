import { z } from "zod";

/** 创作台的四个面板对应的能力。 */
export const CAPABILITIES = ["chat", "image", "video", "tts", "stt"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 后端方言。用响应头确定性识别，不靠猜：
 *   CPA      → X-CPA-Version（在它的 Access-Control-Expose-Headers 白名单里，浏览器读得到）
 *   grok2api → X-Request-ID + /v1/tts 存在
 */
export const BACKEND_FLAVORS = ["cpa", "grok2api", "generic"] as const;
export type BackendFlavor = (typeof BACKEND_FLAVORS)[number];

export const CHAT_PROTOCOLS = ["chat-completions", "responses"] as const;
export type ChatProtocol = (typeof CHAT_PROTOCOLS)[number];

export const BACKEND_MODES = ["direct", "proxy"] as const;
export type BackendMode = (typeof BACKEND_MODES)[number];

/** 模型在 UI 里被归到哪个面板。auto 表示用启发式推断的结果。 */
export const MODEL_KINDS = ["auto", "chat", "image", "video", "tts", "stt", "hidden"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const backendSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 含 /v1 的完整前缀，例如 https://cpa.yueming.uk/v1 */
  baseURL: z.string().min(1),
  /** direct 模式下浏览器直接持有；proxy 模式下留空，由 Worker 注入 */
  apiKey: z.string().default(""),
  mode: z.enum(BACKEND_MODES).default("direct"),
  flavor: z.enum(BACKEND_FLAVORS).default("generic"),
  chatProtocol: z.enum(CHAT_PROTOCOLS).default("chat-completions"),
  /** 探测结果，用户可在设置页手动覆盖 */
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  /** 上次探测时间戳，用来提示"探测结果可能过期了" */
  probedAt: z.number().nullable().default(null),
  /** 手动覆盖某个模型的归类 */
  modelOverrides: z.record(z.string(), z.enum(MODEL_KINDS)).default({}),
  /**
   * 用户勾选保存的模型 id，按数组顺序显示。
   * 聊天时的模型选择器默认只显示这些 —— CPA 一个部署就有 65 个模型，
   * 全列出来根本没法选。为空时降级成显示全部，保证开箱可用。
   */
  savedModels: z.array(z.string()).default([]),
});

export type Backend = z.infer<typeof backendSchema>;

export const backendStateSchema = z.object({
  version: z.literal(1),
  backends: z.array(backendSchema).default([]),
  activeBackendId: z.string().nullable().default(null),
});

export type BackendState = z.infer<typeof backendStateSchema>;

export function createBackendId(): string {
  return `be_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** 规范化用户填的地址：去尾斜杠，没写 /v1 的自动补上。 */
export function normalizeBaseURL(input: string): string {
  let value = input.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "");
  // 用户常常只填域名。绝大多数后端的公开 API 都挂在 /v1 下。
  if (!/\/v\d+(beta)?$/i.test(value)) value = `${value}/v1`;
  return value;
}

export function createBackend(input: Partial<Backend> & { name: string; baseURL: string }): Backend {
  return backendSchema.parse({
    id: input.id ?? createBackendId(),
    name: input.name,
    baseURL: normalizeBaseURL(input.baseURL),
    apiKey: input.apiKey ?? "",
    mode: input.mode ?? "direct",
    flavor: input.flavor ?? "generic",
    chatProtocol: input.chatProtocol ?? "chat-completions",
    capabilities: input.capabilities ?? [],
    probedAt: input.probedAt ?? null,
    modelOverrides: input.modelOverrides ?? {},
    savedModels: input.savedModels ?? [],
  });
}
