import { z } from "zod";

/** 创作台的四个面板对应的能力。 */
export const CAPABILITIES = ["chat", "image", "video", "tts", "stt"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * 后端方言。只保留能由响应头确定性识别的结果：
 *   CPA → X-CPA-Version（在它的 Access-Control-Expose-Headers 白名单里，浏览器读得到）
 * X-Request-ID 是 OpenAI 兼容接口的通用头，不能单独证明后端是 grok2api。
 */
export const BACKEND_FLAVORS = ["cpa", "grok2api", "generic"] as const;
export type BackendFlavor = (typeof BACKEND_FLAVORS)[number];

export const CHAT_PROTOCOLS = ["chat-completions", "responses"] as const;
export type ChatProtocol = (typeof CHAT_PROTOCOLS)[number];

export const BACKEND_MODES = ["direct", "proxy"] as const;
export type BackendMode = (typeof BACKEND_MODES)[number];

/**
 * 语音转写使用当前后端的原生 `/stt`，或绕过当前后端直连独立的
 * OpenAI-compatible `/audio/transcriptions` 服务。
 */
export const STT_PROVIDER_TYPES = ["backend-native", "openai-compatible"] as const;
export type STTProviderType = (typeof STT_PROVIDER_TYPES)[number];

export const sttProviderSchema = z.object({
  type: z.enum(STT_PROVIDER_TYPES).default("backend-native"),
  /** 独立供应商的 API 前缀；使用时才规范化并补 `/v1`。 */
  baseURL: z.string().default(""),
  apiKey: z.string().default(""),
  model: z.string().default(""),
});

export type STTProvider = z.infer<typeof sttProviderSchema>;

/** 语音端点协议。auto 会按目标后端已识别的方言选择，必要时可手动覆盖。 */
export const VOICE_PROTOCOLS = ["auto", "grok-native", "openai-audio"] as const;
export type VoiceProtocol = (typeof VOICE_PROTOCOLS)[number];

/**
 * 语音服务绑定到已经添加的后端，只保存 id，不复制地址和密钥。
 * 空 backendId 表示当前聊天后端；model 为空时由旧配置/面板默认值回退。
 */
export const voiceBindingSchema = z.object({
  backendId: z.string().default(""),
  model: z.string().default(""),
  protocol: z.enum(VOICE_PROTOCOLS).default("auto"),
  /** TTS 自定义路由 id；为空时继续按 protocol 使用内置端点。 */
  // 外层 optional 保持旧对象字面量的源码兼容；解析时仍会用 default 补成空串。
  routeId: z.string().default("").optional(),
});

export type VoiceBinding = z.infer<typeof voiceBindingSchema>;

export const voiceRoutingSchema = z.object({
  stt: voiceBindingSchema.default({ backendId: "", model: "", protocol: "auto", routeId: "" }),
  tts: voiceBindingSchema.default({ backendId: "", model: "", protocol: "auto", routeId: "" }),
});

export type VoiceRouting = z.infer<typeof voiceRoutingSchema>;

/** 模型在 UI 里被归到哪个面板。auto 表示用启发式推断的结果。 */
export const MODEL_KINDS = ["auto", "chat", "image", "video", "tts", "stt", "hidden"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** 聊天模型启用联网时使用哪种工具协议。auto 表示按模型自动选择。 */
export const WEB_SEARCH_MODES = ["auto", "native", "function"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

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

/**
 * 自定义 TTS 路由。
 *
 * body / query 使用与图片自定义路由相同的 `$变量` 模板；响应既可以返回音频 URL，
 * 也可以把音频放在 JSON 的 base64 字段中。点号路径支持 `*` 展开数组。
 */
export const customTTSRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 相对目标后端 baseURL 的路径；设置页和传输层会拒绝完整 URL。 */
  path: z.string().min(1),
  method: z.enum(["POST", "GET"]).default("POST"),
  query: z.record(z.string(), z.string()).default({}),
  body: z.record(z.string(), z.unknown()).default({}),
  /** JSON 响应内可能包含音频 URL 的点号路径。 */
  audioUrlPaths: z.array(z.string()).default([]),
  /** JSON 响应内可能包含纯 base64 或 data URL 的点号路径。 */
  audioBase64Paths: z.array(z.string()).default([]),
  /** base64 响应没有携带类型信息时用于创建 Blob。 */
  mimeType: z.string().min(1).default("audio/mpeg"),
  /** 选择该路由时使用的默认声线；为空时由内置协议决定。 */
  defaultVoice: z.string().default(""),
});

export type CustomTTSRoute = z.infer<typeof customTTSRouteSchema>;

/**
 * 设置页给用户编辑的 TTS 请求格式。
 * 路由元数据和响应音频解析规则由内置模板维护，不随请求格式暴露或修改。
 */
export const customTTSRequestSchema = z.object({
  /** 相对目标后端 baseURL 的路径；不能填写完整 URL。 */
  path: z.string().min(1),
  method: z.enum(["POST", "GET"]).default("POST"),
  query: z.record(z.string(), z.string()).default({}),
  body: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type CustomTTSRequest = z.infer<typeof customTTSRequestSchema>;

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
  /** 聊天输入框录音完成后用于转写的 STT 模型；空字符串表示尚未选择。 */
  chatInputSTTModel: z.string().default(""),
  /** STT 可以沿用当前后端，也可以独立直连另一家 OpenAI-compatible 服务。 */
  /** @deprecated 仅为兼容上一版独立 URL/Key 配置；新设置使用 voiceRouting 引用已有后端。 */
  sttProvider: sttProviderSchema.default({
    type: "backend-native",
    baseURL: "",
    apiKey: "",
    model: "",
  }),
  /** STT/TTS 各自引用一个已添加的后端。 */
  voiceRouting: voiceRoutingSchema.default({
    stt: { backendId: "", model: "", protocol: "auto", routeId: "" },
    tts: { backendId: "", model: "", protocol: "auto", routeId: "" },
  }),
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
  /** 模型 id -> 联网工具协议；没有记录的模型按 auto 处理。 */
  webSearchModeOverrides: z.record(z.string(), z.enum(WEB_SEARCH_MODES)).default({}),
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
  /** 用户定义的 TTS 请求/响应路由；由 voiceRouting.tts.routeId 引用。 */
  customTTSRoutes: z.array(customTTSRouteSchema).default([]),
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
    chatInputSTTModel: input.chatInputSTTModel ?? "",
    sttProvider: input.sttProvider ?? {
      type: "backend-native",
      baseURL: "",
      apiKey: "",
      model: "",
    },
    voiceRouting: input.voiceRouting ?? {
      stt: { backendId: "", model: "", protocol: "auto", routeId: "" },
      tts: { backendId: "", model: "", protocol: "auto", routeId: "" },
    },
    capabilities: input.capabilities ?? [],
    modelOverrides: input.modelOverrides ?? {},
    webSearchModeOverrides: input.webSearchModeOverrides ?? {},
    savedModels: input.savedModels ?? [],
    customImageRoutes: input.customImageRoutes ?? [],
    imageRouteOverrides: input.imageRouteOverrides ?? {},
    defaultImageRoute: input.defaultImageRoute ?? "images",
    customTTSRoutes: input.customTTSRoutes ?? [],
  });
}
