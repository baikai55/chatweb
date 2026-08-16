import { joinURL } from "@/transport/chat-completions";
import { TransportError, firstString, isRecord, parseJSON, toTransportError } from "@/transport/errors";

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
  signal?: AbortSignal;
};

export type SynthesizeSpeechOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  text: string;
  voiceId: string;
  language: string;
  /** 实测上游只接受 0.7–1.5，超出返回 400。 */
  speed?: number;
  /** 实测只有这三种可用；aac / flac 上游返回 422。 */
  outputFormat?: "mp3" | "wav" | "opus";
  withTimestamps?: boolean;
  signal?: AbortSignal;
};

export type TranscribeSpeechOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  file: File;
  language?: string;
  signal?: AbortSignal;
};

/** 获取 TTS 声线。兼容数组以及 voices/data/items/results 等常见包裹字段。 */
export async function listVoices(options: ListVoicesOptions): Promise<VoiceInfo[]> {
  const query = options.model ? `?model=${encodeURIComponent(options.model)}` : "";
  const response = await fetch(joinURL(options.baseURL, `/tts/voices${query}`), {
    method: "GET",
    headers: jsonHeaders(options.apiKey),
    signal: options.signal,
  });
  const responseText = await response.text();
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
}

/** 调用 grok2api 原生 /tts，兼容原始音频和 JSON 包装的 URL/base64。 */
export async function synthesizeSpeech(options: SynthesizeSpeechOptions): Promise<SpeechAudioResult> {
  const body: Record<string, unknown> = {
    model: options.model,
    text: options.text,
    voice_id: options.voiceId,
    language: options.language,
  };
  if (typeof options.speed === "number") body.speed = options.speed;
  if (options.outputFormat) body.output_format = { codec: options.outputFormat };
  if (options.withTimestamps) body.with_timestamps = true;

  const response = await fetch(joinURL(options.baseURL, "/tts"), {
    method: "POST",
    headers: jsonHeaders(options.apiKey, "application/json, audio/*, application/octet-stream"),
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const contentType = normalizeContentType(response.headers.get("content-type"));

  if (!response.ok) {
    throw toTransportError(response, await response.text());
  }

  if (isJSONContentType(contentType)) {
    const responseText = await response.text();
    const payload = parseJSON(responseText);
    const result = readJSONAudio(payload, options.baseURL, contentType);
    if (!result) {
      throw new TransportError(response.status, "语音合成响应里没有可播放的音频", "invalid_response");
    }
    return result;
  }

  if (contentType.startsWith("text/")) {
    const responseText = (await response.text()).trim();
    const result = readAudioValue(responseText, options.baseURL, "audio/mpeg");
    if (result) return result;
    throw new TransportError(response.status, "语音合成响应里没有可播放的音频", "invalid_response");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new TransportError(response.status, "语音合成返回了空音频", "empty_response");
  }
  const mime = normalizeAudioMime(contentType) || codecContentType(options.outputFormat) || "audio/mpeg";
  return {
    url: URL.createObjectURL(new Blob([buffer], { type: mime })),
    contentType: mime,
    source: "binary",
  };
}

/** 上传音频到 grok2api 原生 /stt，并把常见转写响应收敛成统一结构。 */
export async function transcribeSpeech(options: TranscribeSpeechOptions): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("model", options.model);
  // format=true 让上游规范化数字和标点（实测 "十一万五千六百九十九" → "115,699"），
  // 但它**要求同时给出 language** —— 只给 format 会直接 400
  // `Field 'language' is required when 'format' is true`。
  // 语言选「自动识别」时只能放弃格式化，两个字段一起省掉照样能转写。
  if (options.language) {
    form.append("language", options.language);
    form.append("format", "true");
  }
  form.append("file", options.file, options.file.name);

  const headers = new Headers({ Accept: "application/json, text/plain" });
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);

  const response = await fetch(joinURL(options.baseURL, "/stt"), {
    method: "POST",
    headers,
    body: form,
    signal: options.signal,
  });
  const responseText = await response.text();
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
  if (typeof payload === "string") return readAudioValue(payload, baseURL, fallbackContentType);
  if (!isRecord(payload)) return null;

  const duration = readFiniteNumber(payload.duration, payload.duration_seconds, payload.durationSeconds);
  const contentType = firstString(payload.content_type, payload.contentType, payload.mime_type, payload.mimeType)
    || (fallbackContentType.startsWith("audio/") ? fallbackContentType : "audio/mpeg");

  const directURL = firstString(payload.url, payload.audio_url, payload.audioUrl, payload.download_url, payload.downloadUrl);
  if (directURL) {
    const result = readAudioValue(directURL, baseURL, contentType);
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
    return { url: audio, contentType: readDataURLContentType(audio) || contentType, source: "base64" };
  }
  if (audio.startsWith("blob:")) {
    return { url: audio, contentType, source: "url" };
  }
  if (/^https?:\/\//i.test(audio)) {
    return { url: audio, contentType, source: "url" };
  }

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
  return contentType === "audio/opus" ? "audio/ogg" : contentType;
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

function readDataURLContentType(value: string): string {
  const match = /^data:([^;,]+)/i.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}

function resolveMediaURL(value: string, baseURL: string): string {
  try {
    return new URL(value, `${baseURL.replace(/\/+$/, "")}/`).toString();
  } catch {
    return value;
  }
}
