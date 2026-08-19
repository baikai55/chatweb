import type { CustomTTSRoute } from "@/backends/types";
import { joinURL } from "@/transport/chat-completions";
import { TransportError, isRecord, parseJSON, toTransportError } from "@/transport/errors";
import { resolveTemplate, selectByPath } from "@/transport/image-routes";
import type { SpeechAudioResult } from "@/transport/voice";
import { createRequestTimeoutScope, DEFAULT_MEDIA_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

/** 自定义 TTS 请求模板允许引用的变量。 */
export const TTS_ROUTE_TEMPLATE_VARIABLES = [
  "model",
  "text",
  "voice",
  "format",
  "speed",
  "language",
] as const;

export type TTSRouteTemplateVariable = (typeof TTS_ROUTE_TEMPLATE_VARIABLES)[number];

export type TTSRouteContext = {
  model: string;
  text: string;
  voice?: string;
  /** 未指定时使用 wav；MiMo 非流式接口的官方默认值也是 wav。 */
  format?: string;
  speed?: number;
  language?: string;
};

export type ResolvedTTSRoute = {
  id: string;
  name: string;
  url: string;
  method: "POST" | "GET";
  /** GET 请求没有请求体。 */
  body: string | null;
  audioUrlPaths: string[];
  audioBase64Paths: string[];
  contentType: string;
};

export type SynthesizeWithTTSRouteOptions = TTSRouteContext & {
  baseURL: string;
  apiKey: string;
  route: CustomTTSRoute;
  /** 建连和读取音频的单阶段上限。默认 120 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * 自定义路由只能描述所选供应商 Base URL 下的接口路径。
 * 完整 URL 和协议相对 URL 都可能把供应商密钥带到其它域名，因此一律拒绝。
 */
export function isRelativeTTSRoutePath(path: string): boolean {
  const value = path.trim();
  return Boolean(value)
    && !/^[a-z][a-z\d+.-]*:/i.test(value)
    && !value.startsWith("//");
}

/**
 * MiMo-V2.5-TTS 的 OpenAI Chat 兼容模板。
 *
 * 官方非流式请求把待朗读文本放在 assistant 消息中，音频配置放在 audio，
 * 返回值位于 choices[].message.audio.data。format 缺省时是 wav。
 */
export const MIMO_CHAT_TTS_ROUTE: CustomTTSRoute = {
  id: "mimo-chat-tts",
  name: "小米 MiMo 对话语音",
  path: "/chat/completions",
  method: "POST",
  query: {},
  body: {
    model: "$model",
    messages: [{ role: "assistant", content: "$text" }],
    audio: {
      voice: "$voice",
      format: "$format",
    },
    stream: false,
  },
  audioUrlPaths: [],
  // 第一条是官方非流式响应；后两条兼容少数聚合层剥掉 choices/message 包装的结果。
  audioBase64Paths: ["choices.*.message.audio.data", "audio.data", "data"],
  // 这里也是模板；默认 format=wav，因此实际缺省值是 audio/wav。
  mimeType: "audio/${format}",
  defaultVoice: "mimo_default",
};

/** 将自定义路由和本次合成参数展开成可直接交给 fetch 的请求。 */
export function resolveTTSRoute(
  baseURL: string,
  route: CustomTTSRoute,
  context: TTSRouteContext,
): ResolvedTTSRoute {
  const values = toTemplateValues(route, context);
  const resolvedPath = resolveTemplate(route.path, values);
  if (typeof resolvedPath !== "string" || !resolvedPath.trim()) {
    throw new TransportError(0, "TTS 路由没有有效的请求地址", "invalid_route");
  }
  const path = resolvedPath.trim();
  if (!isRelativeTTSRoutePath(path)) {
    throw new TransportError(
      0,
      "TTS 路由只能填写相对于所选供应商 Base URL 的接口路径，不能填写完整网址",
      "invalid_route",
    );
  }

  let url: URL;
  try {
    url = new URL(joinURL(baseURL, path));
  } catch {
    throw new TransportError(0, "TTS 路由的请求地址无效", "invalid_route");
  }

  for (const [key, raw] of Object.entries(route.query)) {
    const value = resolveTemplate(raw, values);
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const rawMime = resolveTemplate(route.mimeType, values);
  const contentType = normalizeAudioMime(typeof rawMime === "string" ? rawMime : "")
    || formatContentType(String(values.format ?? ""))
    || "audio/mpeg";

  return {
    id: route.id,
    name: route.name,
    url: url.toString(),
    method: route.method,
    body: route.method === "GET" ? null : JSON.stringify(resolveTemplate(route.body, values)),
    audioUrlPaths: [...route.audioUrlPaths],
    audioBase64Paths: [...route.audioBase64Paths],
    contentType,
  };
}

/** 通过用户选择的自定义路由合成语音，并把不同响应形状收敛成可播放结果。 */
export async function synthesizeWithTTSRoute(
  options: SynthesizeWithTTSRouteOptions,
): Promise<SpeechAudioResult> {
  const model = options.model.trim();
  const text = options.text.trim();
  if (!model) throw new TransportError(0, "请选择语音合成模型", "invalid_request");
  if (!text) throw new TransportError(0, "请输入要合成的文字", "invalid_request");

  const route = resolveTTSRoute(options.baseURL, options.route, {
    model,
    text,
    voice: options.voice,
    format: options.format,
    speed: options.speed,
    language: options.language,
  });
  const headers = new Headers({ Accept: "application/json, audio/*, application/octet-stream, text/plain" });
  if (route.body !== null) headers.set("Content-Type", "application/json");
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS;
  const request = createRequestTimeoutScope(options.signal);
  let response: Response;
  try {
    response = await request.run(() => fetch(route.url, {
      method: route.method,
      headers,
      body: route.body,
      signal: request.signal,
    }), timeoutMs, "连接语音合成接口");
  } catch (caught) {
    request.dispose();
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    if (caught instanceof TypeError) {
      throw new TransportError(
        0,
        "无法连接语音合成接口。请检查地址、网络和 HTTPS 证书；浏览器直连还要求供应商允许跨域访问（CORS）。",
        "network_error",
      );
    }
    throw caught;
  }

  try {
    if (!response.ok) {
      const responseText = await request.run(() => response.text(), timeoutMs, "读取语音合成错误响应");
      throw toTransportError(response, responseText);
    }

    const responseContentType = normalizeContentType(response.headers.get("content-type"));
    if (isBinaryContentType(responseContentType)) {
      const buffer = await request.run(() => response.arrayBuffer(), timeoutMs, "读取语音音频");
      if (buffer.byteLength === 0) {
        throw new TransportError(response.status, "语音合成返回了空音频", "empty_response");
      }
      const contentType = normalizeAudioMime(responseContentType) || route.contentType;
      return {
        url: URL.createObjectURL(new Blob([buffer], { type: contentType })),
        contentType,
        source: "binary",
      };
    }

    const responseText = await request.run(() => response.text(), timeoutMs, "读取语音合成响应");
    const payload = parseJSON(responseText);
    if (payload !== null) {
      const result = extractRoutedAudio(payload, options.baseURL, route);
      if (result) return result;
    } else if (responseText.trim()) {
      // 少数自定义端点直接返回 URL、data URL 或裸 base64。
      const result = readDirectAudioValue(responseText, options.baseURL, route.contentType);
      if (result) return result;
    }

    throw new TransportError(response.status, "语音合成响应里没有可播放的音频，请检查响应取值路径", "invalid_response");
  } finally {
    request.dispose();
  }
}

/** 按用户配置的点号路径提取第一段可播放音频。`*` 可展开数组。 */
export function extractRoutedAudio(
  payload: unknown,
  baseURL: string,
  route: Pick<ResolvedTTSRoute, "audioUrlPaths" | "audioBase64Paths" | "contentType">,
): SpeechAudioResult | null {
  for (const path of route.audioUrlPaths) {
    for (const value of selectByPath(payload, path)) {
      const candidate = audioString(value, ["url", "uri", "audio_url", "audioUrl"]);
      if (!candidate) continue;
      const result = readAudioURL(candidate, baseURL, route.contentType);
      if (result) return result;
    }
  }

  for (const path of route.audioBase64Paths) {
    for (const value of selectByPath(payload, path)) {
      const candidate = audioString(value, ["data", "base64", "audio", "audio_base64", "audioBase64"]);
      if (!candidate) continue;
      const result = readAudioBase64(candidate, route.contentType);
      if (result) return result;
    }
  }
  return null;
}

/** 返回一条路由实际引用到的受支持变量，供设置页决定展示哪些说明/控件。 */
export function ttsRouteVariables(route: CustomTTSRoute): Set<TTSRouteTemplateVariable> {
  const found = new Set<TTSRouteTemplateVariable>();
  const allowed = new Set<string>(TTS_ROUTE_TEMPLATE_VARIABLES);

  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const name of templateReferences(value)) {
        const root = name.split(".")[0] ?? "";
        if (allowed.has(root)) found.add(root as TTSRouteTemplateVariable);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) scan(child);
    }
  };

  scan(route.path);
  scan(route.query);
  scan(route.body);
  scan(route.mimeType);
  return found;
}

function toTemplateValues(route: CustomTTSRoute, context: TTSRouteContext): Record<string, unknown> {
  const voice = context.voice?.trim() || route.defaultVoice.trim() || undefined;
  const language = context.language?.trim() || undefined;
  const requestedFormat = context.format?.trim().toLowerCase();
  const format = requestedFormat || "wav";
  const speed = typeof context.speed === "number" && Number.isFinite(context.speed)
    ? context.speed
    : undefined;
  return {
    model: context.model.trim(),
    text: context.text.trim(),
    voice,
    format,
    speed,
    language,
  };
}

function audioString(value: unknown, keys: readonly string[]): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function readDirectAudioValue(value: string, baseURL: string, contentType: string): SpeechAudioResult | null {
  const base64 = readAudioBase64(value, contentType);
  if (base64) return base64;
  return readAudioURL(value, baseURL, contentType);
}

function readAudioBase64(value: string, fallbackContentType: string): SpeechAudioResult | null {
  const audio = value.trim();
  if (!audio) return null;
  if (/^data:audio\//i.test(audio)) {
    const separator = audio.indexOf(",");
    if (separator < 0 || !/;base64(?:;|,)/i.test(audio.slice(0, separator + 1))) return null;
    const base64 = normalizeBase64(audio.slice(separator + 1));
    if (!base64) return null;
    const mime = normalizeAudioMime(/^data:([^;,]+)/i.exec(audio)?.[1] ?? "") || fallbackContentType;
    return { url: `data:${mime};base64,${base64}`, contentType: mime, source: "base64" };
  }

  const base64 = normalizeBase64(audio);
  if (!base64) return null;
  return {
    url: `data:${fallbackContentType};base64,${base64}`,
    contentType: fallbackContentType,
    source: "base64",
  };
}

function readAudioURL(value: string, baseURL: string, contentType: string): SpeechAudioResult | null {
  const audio = value.trim();
  if (!audio) return null;
  if (/^data:audio\//i.test(audio)) return readAudioBase64(audio, contentType);
  if (audio.startsWith("blob:") || /^https?:\/\//i.test(audio)) {
    return { url: audio, contentType, source: "url" };
  }
  // 不把 javascript: 等任意 scheme，或带空白的普通文本拼成 URL。
  if (/^[a-z][a-z\d+.-]*:/i.test(audio) || /\s/.test(audio)) return null;
  try {
    return {
      url: new URL(audio, `${baseURL.replace(/\/+$/, "")}/`).toString(),
      contentType,
      source: "url",
    };
  } catch {
    return null;
  }
}

function normalizeBase64(value: string): string | null {
  const compact = value.replaceAll(/\s+/g, "");
  if (compact.length < 16 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return null;
  const standard = compact.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  const remainder = standard.length % 4;
  if (remainder === 1) return null;
  return standard + "=".repeat((4 - remainder) % 4);
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizeAudioMime(value: string): string {
  const mime = normalizeContentType(value);
  if (mime === "audio/mp3" || mime === "audio/mpeg3") return "audio/mpeg";
  if (mime === "audio/x-wav" || mime === "audio/wave") return "audio/wav";
  if (mime === "audio/opus" || mime === "application/ogg") return "audio/ogg";
  return mime.startsWith("audio/") ? mime : "";
}

function formatContentType(format: string): string {
  switch (format.trim().toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "wav":
    case "wave": return "audio/wav";
    case "opus":
    case "ogg": return "audio/ogg";
    case "pcm":
    case "pcm16": return "audio/L16";
    case "aac": return "audio/aac";
    case "flac": return "audio/flac";
    default: return "";
  }
}

function isBinaryContentType(contentType: string): boolean {
  return contentType.startsWith("audio/")
    || contentType === "application/octet-stream"
    || contentType === "application/ogg";
}

const WHOLE_TEMPLATE_REF = /^\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)$/;
const INLINE_TEMPLATE_REF = /\$\{([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}/g;

function templateReferences(value: string): string[] {
  const whole = WHOLE_TEMPLATE_REF.exec(value);
  if (whole) return [whole[1]];
  return Array.from(value.matchAll(INLINE_TEMPLATE_REF), (match) => match[1]);
}
