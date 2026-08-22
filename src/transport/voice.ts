import { joinURL } from "@/transport/url";
import { TransportError, firstString, isRecord, parseJSON, toTransportError } from "@/transport/errors";
import { synthesizeWithTTSRoute } from "@/transport/tts-routes";
import type { CustomTTSRoute } from "@/backends/types";
import type { STTProtocol } from "@/transport/stt-provider";
import type { ResolvedVoiceProtocol } from "@/transport/voice-routing";
import {
  createRequestTimeoutScope,
  DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "@/transport/request-timeout";

export type VoiceInfo = {
  voiceId: string;
  name: string;
  language?: string;
  description?: string;
};

export type SpeechAudioResult = {
  url: string;
  contentType: string;
  duration?: number;
  source: "binary" | "base64" | "url";
};

export type TranscriptionWord = {
  text: string;
  start: number;
  end: number;
  speaker?: number | string;
};

export type TranscriptionResult = {
  text: string;
  language?: string;
  duration?: number;
  words?: TranscriptionWord[];
};

/** 与 grok2api 旧创作台的公开类型名保持兼容。 */
export type TTSResult = SpeechAudioResult;
export type STTResult = TranscriptionResult;

export type ListVoicesOptions = {
  baseURL: string;
  apiKey: string;
  model?: string;
  /** 省略时保持原有 grok2api `/tts/voices` 行为。 */
  protocol?: ResolvedVoiceProtocol;
  /** 建连和读取列表的单阶段上限。默认 60 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

export type SynthesizeSpeechOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  text: string;
  voiceId: string;
  language?: string;
  /** 省略时保持原有 grok2api `/tts` 行为。 */
  protocol?: ResolvedVoiceProtocol;
  /** 有值时使用用户创建的 TTS 模板，不再调用 protocol 对应的内置端点。 */
  customRoute?: CustomTTSRoute;
  /** 实测上游只接受 0.7–1.5，超出返回 400。 */
  speed?: number;
  /** 实测只有这三种可用；aac / flac 上游返回 422。 */
  outputFormat?: "mp3" | "wav" | "opus";
  withTimestamps?: boolean;
  /** 建连和读取音频的单阶段上限。默认 120 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

export type TranscribeSpeechOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  file: File;
  /** 省略时保持原有 grok2api `/stt` 行为。 */
  protocol?: STTProtocol | ResolvedVoiceProtocol;
  language?: string;
  /** 建连和读取转写结果的单阶段上限。默认 120 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

/** 获取 TTS 声线。兼容数组以及 voices/data/items/results 等常见包裹字段。 */
export async function listVoices(options: ListVoicesOptions): Promise<VoiceInfo[]> {
  // OpenAI Audio 没有所有兼容供应商都实现的标准声线列表端点。
  // 返回空列表让 UI 使用可编辑的 voice ID，不向未知路径发探测请求。
  if (options.protocol === "openai-audio") return [];

  const query = options.model ? `?model=${encodeURIComponent(options.model)}` : "";
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createRequestTimeoutScope(options.signal);
  try {
    const response = await request.run(() => fetch(joinURL(options.baseURL, `/tts/voices${query}`), {
      method: "GET",
      headers: jsonHeaders(options.apiKey),
      signal: request.signal,
    }), timeoutMs, "连接声线列表接口");
    const responseText = await request.run(() => response.text(), timeoutMs, "读取声线列表");
    if (!response.ok) throw toTransportError(response, responseText);

    const payload = parseJSON(responseText);
    const rows = readVoiceRows(payload);
    if (!rows) {
      throw new TransportError(response.status, "声线列表返回了无法识别的数据", "invalid_response");
    }

    const voices = rows.flatMap(readVoice);
    const seen = new Set<string>();
    return voices.filter((voice) => {
      if (seen.has(voice.voiceId)) return false;
      seen.add(voice.voiceId);
      return true;
    });
  } finally {
    request.dispose();
  }
}

/** 调用 grok2api `/tts` 或 OpenAI `/audio/speech`。 */
export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SpeechAudioResult> {
  if (options.customRoute) {
    return synthesizeWithTTSRoute({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      route: options.customRoute,
      model: options.model,
      text: options.text,
      voice: options.voiceId,
      language: options.language,
      speed: options.speed,
      format: options.outputFormat,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    });
  }

  const protocol = options.protocol ?? "grok-native";
  const body: Record<string, unknown> = protocol === "openai-audio"
    ? {
        model: options.model,
        input: options.text,
        voice: options.voiceId,
      }
    : {
        model: options.model,
        text: options.text,
        voice_id: options.voiceId,
        language: options.language,
      };
  if (typeof options.speed === "number") body.speed = options.speed;
  if (options.outputFormat) {
    if (protocol === "openai-audio") body.response_format = options.outputFormat;
    else body.output_format = { codec: options.outputFormat };
  }
  if (protocol === "grok-native" && options.withTimestamps) body.with_timestamps = true;

  const path = protocol === "openai-audio" ? "/audio/speech" : "/tts";
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS;
  const request = createRequestTimeoutScope(options.signal);
  try {
    const response = await request.run(() => fetch(joinURL(options.baseURL, path), {
      method: "POST",
      headers: jsonHeaders(options.apiKey, "application/json, audio/*, application/octet-stream"),
      body: JSON.stringify(body),
      signal: request.signal,
    }), timeoutMs, "连接语音合成接口");
    const contentType = normalizeContentType(response.headers.get("content-type"));

    if (!response.ok) {
      const responseText = await request.run(() => response.text(), timeoutMs, "读取语音合成错误响应");
      throw toTransportError(response, responseText);
    }

    if (isJSONContentType(contentType)) {
      const responseText = await request.run(() => response.text(), timeoutMs, "读取语音合成响应");
      const payload = parseJSON(responseText);
      const result = readJSONAudio(
        payload,
        options.baseURL,
        codecContentType(options.outputFormat) || contentType,
      );
      if (!result) {
        throw new TransportError(response.status, "语音合成响应里没有可播放的音频", "invalid_response");
      }
      return result;
    }

    if (contentType.startsWith("text/")) {
      const responseText = (await request.run(() => response.text(), timeoutMs, "读取语音合成响应")).trim();
      const result = readAmbiguousAudioValue(
        responseText,
        options.baseURL,
        codecContentType(options.outputFormat) || "audio/mpeg",
      );
      if (result) return result;
      throw new TransportError(response.status, "语音合成响应里没有可播放的音频", "invalid_response");
    }

    const buffer = await request.run(() => response.arrayBuffer(), timeoutMs, "读取语音音频");
    if (buffer.byteLength === 0) {
      throw new TransportError(response.status, "语音合成返回了空音频", "empty_response");
    }
    const mime = normalizeAudioMime(contentType) || codecContentType(options.outputFormat) || "audio/mpeg";
    return {
      url: URL.createObjectURL(new Blob([buffer], { type: mime })),
      contentType: mime,
      source: "binary",
    };
  } finally {
    request.dispose();
  }
}

/** 上传音频到 grok2api `/stt` 或 OpenAI `/audio/transcriptions`。 */
export async function transcribeSpeech(options: TranscribeSpeechOptions): Promise<TranscriptionResult> {
  const protocol = options.protocol ?? "grok-stt";
  const openAIAudio = protocol === "openai-transcriptions" || protocol === "openai-audio";
  const form = new FormData();
  form.append("model", options.model);
  if (options.language) {
    form.append("language", options.language);
    if (!openAIAudio) {
      // grok2api 的 format=true 会规范化数字和标点，但要求同时给 language。
      // OpenAI Audio Transcriptions 没有这个字段，不能把它转发给兼容供应商。
      form.append("format", "true");
    }
  }
  form.append("file", options.file, options.file.name);

  const headers = new Headers({ Accept: "application/json, text/plain" });
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);

  const path = openAIAudio ? "/audio/transcriptions" : "/stt";
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_MEDIA_REQUEST_TIMEOUT_MS;
  const request = createRequestTimeoutScope(options.signal);
  let response: Response;
  try {
    response = await request.run(() => fetch(joinURL(options.baseURL, path), {
      method: "POST",
      headers,
      body: form,
      signal: request.signal,
    }), timeoutMs, "连接语音转写接口");
  } catch (caught) {
    request.dispose();
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    if (caught instanceof TypeError) {
      throw new TransportError(
        0,
        "无法连接语音转写接口。请检查地址、网络和 HTTPS 证书；浏览器直连还要求供应商允许跨域访问（CORS）。",
        "network_error",
      );
    }
    throw caught;
  }
  try {
    const responseText = await request.run(() => response.text(), timeoutMs, "读取语音转写响应");
    if (!response.ok) throw toTransportError(response, responseText);

    const payload = parseJSON(responseText);
    if (payload === null) {
      const text = responseText.trim();
      if (text) return { text };
      throw new TransportError(response.status, "语音识别返回了空文本", "empty_response");
    }

    const result = readTranscription(payload);
    if (!result) {
      throw new TransportError(response.status, "语音识别返回了无法识别的数据", "invalid_response");
    }
    return result;
  } finally {
    request.dispose();
  }
}

/** 释放由二进制响应创建的对象 URL。URL/base64 结果无需释放。 */
export function releaseSpeechAudio(result: SpeechAudioResult | null | undefined): void {
  if (result?.source === "binary" && result.url.startsWith("blob:")) {
    URL.revokeObjectURL(result.url);
  }
}

function jsonHeaders(apiKey: string, accept = "application/json"): Headers {
  const headers = new Headers({ Accept: accept, "Content-Type": "application/json" });
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function readVoiceRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["voices", "data", "items", "results"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      for (const nestedKey of ["voices", "data", "items", "results"]) {
        const nested = value[nestedKey];
        if (Array.isArray(nested)) return nested;
      }
    }
  }
  return null;
}

function readVoice(value: unknown): VoiceInfo[] {
  if (typeof value === "string" && value.trim()) {
    return [{ voiceId: value.trim(), name: value.trim() }];
  }
  if (!isRecord(value)) return [];

  const id = firstString(value.voice_id, value.voiceId, value.id, value.voice, value.slug);
  if (!id) return [];
  const language = readLanguage(value.language ?? value.languages ?? value.locale ?? value.lang);
  return [{
    voiceId: id,
    name: firstString(value.name, value.display_name, value.displayName, value.label, value.title) || id,
    language: language || undefined,
    description: firstString(value.description, value.preview_text, value.previewText) || undefined,
  }];
}

function readLanguage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join(", ");
  }
  return "";
}

function readJSONAudio(payload: unknown, baseURL: string, fallbackContentType: string): SpeechAudioResult | null {
  if (typeof payload === "string") return readAmbiguousAudioValue(payload, baseURL, fallbackContentType);
  if (!isRecord(payload)) return null;

  const duration = readFiniteNumber(payload.duration, payload.duration_seconds, payload.durationSeconds);
  // JSON 响应本身的 Content-Type 通常是 application/json；有些上游还会把
  // 音频类型笼统写成 application/octet-stream。二者都不能压过请求的 codec。
  const contentType = normalizeAudioMime(
    firstString(payload.content_type, payload.contentType, payload.mime_type, payload.mimeType),
  ) || normalizeAudioMime(fallbackContentType) || "audio/mpeg";

  const directURL = firstString(payload.url, payload.audio_url, payload.audioUrl, payload.download_url, payload.downloadUrl);
  if (directURL) {
    const result = readAudioURLValue(directURL, baseURL, contentType);
    return result ? { ...result, duration } : null;
  }

  const directAudio = firstString(payload.audio, payload.audio_base64, payload.audioBase64, payload.b64_json, payload.base64);
  if (directAudio) {
    const result = readAudioValue(directAudio, baseURL, contentType);
    return result ? { ...result, duration } : null;
  }

  if (isRecord(payload.audio)) {
    const nested = readJSONAudio(payload.audio, baseURL, contentType);
    if (nested) return { ...nested, duration: duration ?? nested.duration };
  }

  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      const nested = readJSONAudio(item, baseURL, contentType);
      if (nested) return { ...nested, duration: duration ?? nested.duration };
    }
  } else if (isRecord(payload.data)) {
    const nested = readJSONAudio(payload.data, baseURL, contentType);
    if (nested) return { ...nested, duration: duration ?? nested.duration };
  } else if (typeof payload.data === "string") {
    const nested = readAudioValue(payload.data, baseURL, contentType);
    if (nested) return { ...nested, duration };
  }

  return null;
}

function readAudioValue(value: string, baseURL: string, contentType: string): SpeechAudioResult | null {
  const audio = value.trim();
  if (!audio) return null;

  if (audio.startsWith("data:")) {
    const normalized = normalizeAudioDataURL(audio, contentType);
    return { ...normalized, source: "base64" };
  }
  if (audio.startsWith("blob:")) {
    return { url: audio, contentType, source: "url" };
  }
  if (/^https?:\/\//i.test(audio)) {
    return { url: audio, contentType, source: "url" };
  }

  // MP3 裸 base64 经常以 `//u` 开头，看起来像根相对 URL。audio_base64 / audio /
  // data 等字节字段必须优先按 base64 解释，明确的 URL 字段另走 readAudioURLValue。
  const base64 = normalizeBase64(audio);
  if (base64) {
    return {
      url: `data:${contentType || "audio/mpeg"};base64,${base64}`,
      contentType: contentType || "audio/mpeg",
      source: "base64",
    };
  }
  if (looksLikeRelativeMediaURL(audio)) {
    return { url: resolveMediaURL(audio, baseURL), contentType, source: "url" };
  }
  return null;
}

/** 顶层字符串没有字段名提示语义：先认无歧义路径，再回落到“base64 优先”。 */
function readAmbiguousAudioValue(value: string, baseURL: string, contentType: string): SpeechAudioResult | null {
  const audio = value.trim();
  if (looksLikeUnambiguousRelativeMediaURL(audio)) {
    return { url: resolveMediaURL(audio, baseURL), contentType, source: "url" };
  }
  return readAudioValue(audio, baseURL, contentType);
}

/** URL 字段可以安全地把无前导斜杠、无扩展名的值按相对地址解析。 */
function readAudioURLValue(value: string, baseURL: string, contentType: string): SpeechAudioResult | null {
  const audio = value.trim();
  if (!audio) return null;

  if (audio.startsWith("data:")) {
    const normalized = normalizeAudioDataURL(audio, contentType);
    return { ...normalized, source: "base64" };
  }
  if (audio.startsWith("blob:") || /^https?:\/\//i.test(audio)) {
    return { url: audio, contentType, source: "url" };
  }
  // 不放行 javascript: 等任意 scheme，也不把带空白的普通文本拼成 URL。
  if (/^[a-z][a-z\d+.-]*:/i.test(audio) || /\s/.test(audio)) return null;
  return { url: resolveMediaURL(audio, baseURL), contentType, source: "url" };
}

function readTranscription(payload: unknown): TranscriptionResult | null {
  if (typeof payload === "string") return payload.trim() ? { text: payload.trim() } : null;
  if (!isRecord(payload)) return null;

  const nested = isRecord(payload.data) ? payload.data : undefined;
  const text = firstString(
    payload.text,
    payload.transcript,
    payload.transcription,
    nested?.text,
    nested?.transcript,
    nested?.transcription,
  );
  if (!text) return null;

  const wordSource = Array.isArray(payload.words)
    ? payload.words
    : Array.isArray(nested?.words)
      ? nested.words
      : undefined;
  const words = wordSource?.flatMap(readTranscriptionWord);

  return {
    text,
    language: firstString(payload.language, payload.lang, nested?.language, nested?.lang) || undefined,
    duration: readFiniteNumber(payload.duration, payload.duration_seconds, nested?.duration, nested?.duration_seconds),
    words: words && words.length > 0 ? words : undefined,
  };
}

function readTranscriptionWord(value: unknown): TranscriptionWord[] {
  if (!isRecord(value)) return [];
  const text = firstString(value.text, value.word);
  if (!text) return [];
  return [{
    text,
    start: readFiniteNumber(value.start, value.start_time, value.startTime) ?? 0,
    end: readFiniteNumber(value.end, value.end_time, value.endTime) ?? 0,
    speaker: typeof value.speaker === "number" || typeof value.speaker === "string" ? value.speaker : undefined,
  }];
}

function readFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isJSONContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

function codecContentType(codec: SynthesizeSpeechOptions["outputFormat"]): string {
  switch (codec) {
    case "wav": return "audio/wav";
    case "opus": return "audio/ogg";
    case "mp3": return "audio/mpeg";
    default: return "";
  }
}

/**
 * 实测 opus 的响应头写的是 `audio/opus`，但负载魔数是 `OggS` —— 是 Ogg 容器。
 * `audio/opus` 不在浏览器认的 MIME 列表里，直接拿它建 Blob 有被拒播的风险，
 * 统一换成 `audio/ogg`。
 */
function normalizeAudioMime(contentType: string): string {
  const mime = normalizeContentType(contentType);
  if (mime === "audio/opus" || mime === "application/ogg") return "audio/ogg";
  // application/octet-stream 只是“二进制”，不是可播放格式。返回空值让调用方
  // 使用请求的 output_format；其他非音频响应头同理。
  return mime.startsWith("audio/") ? mime : "";
}

function normalizeBase64(value: string): string | null {
  const compact = value.replaceAll(/\s+/g, "");
  if (compact.length < 16 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return null;
  const standard = compact.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  const remainder = standard.length % 4;
  if (remainder === 1) return null;
  return standard + "=".repeat((4 - remainder) % 4);
}

function looksLikeRelativeMediaURL(value: string): boolean {
  return /^(\/|\.\/|\.\.\/)/.test(value)
    || /\.(mp3|wav|wave|ogg|opus|aac|m4a|flac)([?#].*)?$/i.test(value);
}

function looksLikeUnambiguousRelativeMediaURL(value: string): boolean {
  return /^(\.\/|\.\.\/)/.test(value)
    || /^\/[^/\s]+\/.+/.test(value)
    || /^\/\/[^/\s]+\.[^/\s]+(?:\/|$)/.test(value)
    || /\.(mp3|wav|wave|ogg|opus|aac|m4a|flac)([?#].*)?$/i.test(value);
}

function readDataURLContentType(value: string): string {
  const match = /^data:([^;,]+)/i.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}

function normalizeAudioDataURL(value: string, fallback: string): { url: string; contentType: string } {
  const contentType = normalizeAudioMime(readDataURLContentType(value))
    || normalizeAudioMime(fallback)
    || "audio/mpeg";
  return {
    url: value.replace(/^data:[^;,]*/i, `data:${contentType}`),
    contentType,
  };
}

function resolveMediaURL(value: string, baseURL: string): string {
  try {
    return new URL(value, `${baseURL.replace(/\/+$/, "")}/`).toString();
  } catch {
    return value;
  }
}
