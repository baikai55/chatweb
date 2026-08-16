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

/**
 * 图片模型走哪条请求路线。
 *
 * 光靠分类判断不出来 —— 实测 CPA 上 Nano Banana 确实是图片模型，
 * 但它明确拒绝 `/images/generations`，只能走 chat/completions；
 * grok2api 的生图也支持 chat 格式。所以路线得能单独指定。
 */
export const BUILTIN_IMAGE_ROUTES = ["images", "chat"] as const;
export type BuiltinImageRoute = (typeof BUILTIN_IMAGE_ROUTES)[number];

/**
 * 自定义图片路由：把请求体和取图路径都交给用户描述。
 *
 * 设计对齐 gpt-image-playground 的 custom provider：
 *   - body 是模板，字符串以 `$` 开头表示从上下文取值（`$prompt`、`$params.size`），
 *     其余按字面量发送。取不到值的键会被剪掉，可选参数不用写条件分支。
 *   - imageUrlPaths / b64JsonPaths 是点号路径，`*` 展开数组
 *     （例如 `choices.*.message.images.*.url`）。
 *   - 两个路径都留空时回落到通用深度提取，多数后端不用填。
 *
 * 暂不支持异步任务轮询 —— 目前接触到的图片端点都是同步返回的，
 * 真需要时参照 `src/transport/videos.ts` 的轮询实现再加。
 */
export const customImageRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 相对 baseURL 的路径，例如 chat/completions */
  path: z.string().min(1),
  method: z.enum(["POST", "GET"]).default("POST"),
  query: z.record(z.string(), z.string()).default({}),
  body: z.record(z.string(), z.unknown()).default({}),
  imageUrlPaths: z.array(z.string()).default([]),
  b64JsonPaths: z.array(z.string()).default([]),
});

export type CustomImageRoute = z.infer<typeof customImageRouteSchema>;

export const backendSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 含 /v1 的完整前缀，例如 https://cpa.yueming.uk/v1 */
  baseURL: z.string().min(1),
  /** direct 模式下浏览器直接持有；proxy 模式下留空，由 Worker 注入 */
  apiKey: z.string().default(""),
  mode: z.enum(BACKEND_MODES).default("direct"),
  /** 拉模型列表时从响应头认出来的（见 model-catalog 的 readFlavor），不单独探测 */
  flavor: z.enum(BACKEND_FLAVORS).default("generic"),
  chatProtocol: z.enum(CHAT_PROTOCOLS).default("chat-completions"),
  /**
   * 决定侧边栏显示哪几个面板，用户自己勾。
   *
   * 以前是靠探测端点自动填的 —— 已经去掉了：那要对 5 个端点各发一次空请求，
   * 有些站会把这种密集小请求判成测活直接封号。宁可多显示一个面板让用户点进去
   * 看到真实报错，也不值得为此冒风险。
   *
   * 为空表示"不知道"，此时全部显示（老配置和导入的配置会走到这里）。
   */
  capabilities: z.array(z.enum(CAPABILITIES)).default([]),
  /** 手动覆盖某个模型的归类 */
  modelOverrides: z.record(z.string(), z.enum(MODEL_KINDS)).default({}),
  /**
   * 用户勾选保存的模型 id，按数组顺序显示。
   * 聊天时的模型选择器只显示这些 —— CPA 一个部署就有 68 个模型，
   * 全列出来根本没法选。一个都没保存时给提示引导去设置页，
   * **不做「降级显示全部」** —— 那样分不清这一长串是自己选的还是系统兜底的。
   */
  savedModels: z.array(z.string()).default([]),
  /** 用户定义的图片路由 */
  customImageRoutes: z.array(customImageRouteSchema).default([]),
  /** 模型 id → 路由 id（内置 images / chat，或某条自定义路由的 id） */
  imageRouteOverrides: z.record(z.string(), z.string()).default({}),
  /** 没有单独指定路由的图片模型默认走哪条 */
  defaultImageRoute: z.string().default("images"),
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
    modelOverrides: input.modelOverrides ?? {},
    savedModels: input.savedModels ?? [],
    customImageRoutes: input.customImageRoutes ?? [],
    imageRouteOverrides: input.imageRouteOverrides ?? {},
    defaultImageRoute: input.defaultImageRoute ?? "images",
  });
}
