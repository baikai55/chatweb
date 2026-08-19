import { firstString, isRecord, parseJSON, readError, toTransportError, TransportError } from "@/transport/errors";
import { joinURL } from "@/transport/chat-completions";
import { fetchWorkerApi, WorkerAuthorizationError } from "@/transport/worker-access";
import {
  createRequestTimeoutScope,
  DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "@/transport/request-timeout";

/** 视频任务一直处于 pending 时的默认轮询总上限。 */
export const DEFAULT_VIDEO_POLL_TIMEOUT_MS = 30 * 60_000;

/** 一个可以喂给视频生成接口的源媒体。文件会先由面板上传成公网 URL。 */
export type VideoSource = {
  url: string;
  kind: "image" | "video";
  contentType?: string;
};

export type UploadedVideoInput = {
  url: string;
  contentType?: string;
  size?: number;
  key?: string;
};

export type VideoGenerationStatus = {
  requestId: string;
  status: "pending" | "done" | "failed";
  /** 上游原始状态，便于 UI 在联调时说明方言差异。 */
  rawStatus?: string;
  model?: string;
  progress: number;
  video?: { url: string; duration?: number };
  error?: { code?: string; message: string };
};

export type VideoGenerationJob = {
  requestId: string;
  status: VideoGenerationStatus;
};

type VideoJobInput = {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** 提交和读取响应的单阶段上限。默认 60 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

export type VideoGenerationInput = VideoJobInput & {
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  source?: VideoSource;
};

export type VideoEditInput = VideoJobInput & {
  source: VideoSource;
};

export type VideoExtendInput = VideoJobInput & {
  source: VideoSource;
  /** xAI/grok2api 当前接受 2-10 秒的延长量。 */
  duration?: number;
};

/**
 * 把本地图片/视频交给当前应用的 Worker，得到上游可以访问的公网 URL。
 * 不手动设置 Content-Type，让浏览器为 multipart 自动带 boundary。
 */
export async function uploadVideoInput(
  file: File,
  signal?: AbortSignal,
  requestTimeoutMs = DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
): Promise<UploadedVideoInput> {
  if (file.size <= 0) throw new Error("文件是空的");
  if (file.type && !file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    throw new Error("只支持图片或视频文件");
  }

  const form = new FormData();
  form.append("file", file, file.name || "upload");
  const request = createRequestTimeoutScope(signal);
  try {
    const response = await request.run(() => fetchWorkerApi("/__api/upload", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
      signal: request.signal,
    }), requestTimeoutMs, "上传视频素材");
    const text = await request.run(() => response.text(), requestTimeoutMs, "读取上传响应");
    const payload = parseJSON(text);
    if (response.status === 401) {
      throw new WorkerAuthorizationError("上传未获得 Worker 授权，请在设置的“联网”页验证访问口令");
    }
    if (!response.ok) throw toTransportError(response, text);

    const url = readURL(payload);
    if (!url) throw new TransportError(response.status, "上传响应里没有公网 URL", "invalid_upload_response");
    return {
      url,
      contentType: firstStringFromPayload(payload, ["contentType", "content_type", "mime", "mime_type"]) || undefined,
      size: readNumberFromPayload(payload, ["size", "bytes", "file_size"]),
      key: firstStringFromPayload(payload, ["key", "object_key", "path"]) || undefined,
    };
  } finally {
    request.dispose();
  }
}

/** 提交一个视频生成任务。不同后端常用的 request_id / id / task_id 都会被识别。 */
export async function createVideoGeneration(input: VideoGenerationInput): Promise<VideoGenerationJob> {
  const body = videoJobBody(input);
  if (typeof input.duration === "number" && Number.isFinite(input.duration)) body.duration = input.duration;
  if (input.aspectRatio?.trim()) body.aspect_ratio = input.aspectRatio.trim();
  if (input.resolution?.trim()) body.resolution = input.resolution.trim();

  if (input.source) {
    if (input.source.kind !== "image") {
      throw new TransportError(0, "视频生成只接受源图片；编辑或延长请使用对应接口", "invalid_request");
    }
    const url = input.source.url.trim();
    if (!url) throw new TransportError(0, "源图片 URL 不能为空", "invalid_request");
    body.image = { url };
  }

  return submitVideoJob(input, "/videos/generations", body);
}

/** 使用一个公网源视频提交编辑任务。 */
export async function editVideoGeneration(input: VideoEditInput): Promise<VideoGenerationJob> {
  const body = videoJobBody(input);
  body.video = { url: requireVideoSource(input.source) };
  return submitVideoJob(input, "/videos/edits", body);
}

/** 使用一个公网源视频提交延长任务，延长量可省略并交给后端使用默认值。 */
export async function extendVideoGeneration(input: VideoExtendInput): Promise<VideoGenerationJob> {
  const body = videoJobBody(input);
  body.video = { url: requireVideoSource(input.source) };
  if (input.duration !== undefined) {
    if (!Number.isInteger(input.duration) || input.duration < 2 || input.duration > 10) {
      throw new TransportError(0, "视频延长时长必须是 2 到 10 秒之间的整数", "invalid_request");
    }
    body.duration = input.duration;
  }
  return submitVideoJob(input, "/videos/extensions", body);
}

async function submitVideoJob(
  input: VideoJobInput,
  path: "/videos/generations" | "/videos/edits" | "/videos/extensions",
  body: Record<string, unknown>,
): Promise<VideoGenerationJob> {
  const payload = await requestJSON(joinURL(input.baseURL, path), {
    method: "POST",
    headers: authHeaders(input.apiKey),
    body: JSON.stringify(body),
    signal: input.signal,
  }, input.requestTimeoutMs);

  const requestId = readVideoRequestId(payload);
  const status = readVideoGenerationStatus(payload, requestId, input.baseURL);
  // 有些同步兼容端点直接返回 video.url；这种情况不需要再造一个虚假的轮询 ID。
  if (!requestId && !status.video) {
    throw new TransportError(200, "视频响应里没有 request_id、id 或 task_id", "invalid_response");
  }
  return { requestId, status };
}

function videoJobBody(input: VideoJobInput): Record<string, unknown> {
  const model = input.model.trim();
  const prompt = input.prompt.trim();
  if (!model) throw new TransportError(0, "视频模型不能为空", "invalid_request");
  if (!prompt) throw new TransportError(0, "视频描述不能为空", "invalid_request");
  return { model, prompt };
}

function requireVideoSource(source: VideoSource): string {
  if (source.kind !== "video") {
    throw new TransportError(0, "视频编辑和延长必须使用源视频", "invalid_request");
  }
  const url = source.url.trim();
  if (!url) throw new TransportError(0, "源视频 URL 不能为空", "invalid_request");
  return url;
}

/** 查询一个视频任务的当前状态。 */
export async function getVideoGeneration(input: {
  baseURL: string;
  apiKey: string;
  requestId: string;
  /** 单次状态请求建连和读取正文的单阶段上限。默认 60 秒。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<VideoGenerationStatus> {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error("视频任务 ID 不能为空");
  const payload = await requestJSON(joinURL(input.baseURL, `/videos/${encodeURIComponent(requestId)}`), {
    method: "GET",
    headers: authHeaders(input.apiKey),
    signal: input.signal,
  }, input.requestTimeoutMs);
  return readVideoGenerationStatus(payload, requestId, input.baseURL);
}

export type PollVideoGenerationInput = {
  baseURL: string;
  apiKey: string;
  requestId: string;
  /** 创建响应已经带状态时可传入，避免丢掉首帧的进度和错误。 */
  initial?: VideoGenerationStatus;
  intervalMs?: number;
  /** 每次状态请求的单阶段上限。默认 60 秒。 */
  requestTimeoutMs?: number;
  /** 任务持续 pending 的总上限。默认 30 分钟。 */
  pollTimeoutMs?: number;
  onUpdate?: (status: VideoGenerationStatus) => void;
  signal?: AbortSignal;
};

/**
 * 可取消的轮询器。服务端没有统一的 cancel API，所以取消只停止浏览器的请求和等待；
 * 已提交的上游任务是否继续运行由后端决定。
 */
export async function pollVideoGeneration(input: PollVideoGenerationInput): Promise<VideoGenerationStatus> {
  let current = input.initial;
  if (current) {
    input.onUpdate?.(current);
    if (isTerminal(current)) return current;
  }

  const polling = createRequestTimeoutScope(input.signal);
  try {
    return await polling.run(async () => {
      while (true) {
        throwIfAborted(polling.signal);
        // 创建后先立即读一次，随后才按间隔轮询，避免无意义地让用户等首个状态。
        current = await getVideoGeneration({
          baseURL: input.baseURL,
          apiKey: input.apiKey,
          requestId: input.requestId,
          requestTimeoutMs: input.requestTimeoutMs,
          signal: polling.signal,
        });
        input.onUpdate?.(current);
        if (isTerminal(current)) return current;
        await waitWithAbort(input.intervalMs ?? 3_000, polling.signal);
      }
    }, input.pollTimeoutMs ?? DEFAULT_VIDEO_POLL_TIMEOUT_MS, "等待视频生成");
  } finally {
    polling.dispose();
  }
}

/** 公开给面板/测试的状态解码器，兼容常见 envelope 和字段命名。 */
export function readVideoGenerationStatus(
  payload: unknown,
  requestId = "",
  baseURL?: string,
): VideoGenerationStatus {
  const candidates = collectCandidates(payload);
  const rawStatus = firstStringFromCandidates(candidates, ["status", "state", "phase"]).toLowerCase();
  const videoURL = readURL(payload);
  const error = readVideoError(candidates);
  const status = normalizeStatus(rawStatus, Boolean(videoURL), Boolean(error));
  const id = requestId || readVideoRequestId(payload);
  const duration = readNumberFromCandidates(candidates, ["duration", "seconds", "length"])
    ?? readNestedVideoNumber(candidates, "duration");

  return {
    requestId: id,
    status,
    rawStatus: rawStatus || undefined,
    model: firstStringFromCandidates(candidates, ["model", "model_id", "modelId"]) || undefined,
    progress: readProgress(candidates, status),
    video: videoURL ? { url: baseURL ? resolveMediaURL(videoURL, baseURL) : videoURL, duration } : undefined,
    error: error ?? undefined,
  };
}

export function readVideoRequestId(payload: unknown): string {
  return firstStringFromCandidates(collectCandidates(payload), [
    "request_id", "requestId", "task_id", "taskId", "job_id", "jobId", "generation_id", "generationId", "video_id", "videoId", "id",
  ]);
}

function authHeaders(apiKey: string): Headers {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (apiKey.trim()) headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  return headers;
}

async function requestJSON(url: string, init: RequestInit, configuredTimeoutMs?: number): Promise<unknown> {
  const timeoutMs = configuredTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createRequestTimeoutScope(init.signal ?? undefined);
  try {
    const response = await request.run(() => fetch(url, { ...init, signal: request.signal }), timeoutMs, "连接视频接口");
    const text = await request.run(() => response.text(), timeoutMs, "读取视频接口响应");
    if (!response.ok) throw toTransportError(response, text);
    if (!text.trim()) throw new TransportError(response.status, "上游返回了空响应", "invalid_response");
    const payload = parseJSON(text);
    if (payload === null) throw new TransportError(response.status, "上游返回了无法解析的 JSON", "invalid_response");
    return payload;
  } finally {
    request.dispose();
  }
}

function collectCandidates(payload: unknown): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const seen = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;
    if (Array.isArray(entry.value)) {
      for (const item of entry.value) queue.push({ value: item, depth: entry.depth });
      continue;
    }
    if (!isRecord(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    result.push(entry.value);
    if (entry.depth >= 3) continue;
    for (const key of [
      "data", "result", "results", "task", "tasks", "job", "jobs", "video", "videos",
      "output", "outputs", "response", "responses", "generation", "generations", "items",
    ]) {
      const child = entry.value[key];
      if (isRecord(child)) queue.push({ value: child, depth: entry.depth + 1 });
      else if (Array.isArray(child)) {
        for (const item of child) if (isRecord(item)) queue.push({ value: item, depth: entry.depth + 1 });
      }
    }
  }
  return result;
}

function firstStringFromCandidates(candidates: Array<Record<string, unknown>>, keys: string[]): string {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return "";
}

function firstStringFromPayload(payload: unknown, keys: string[]): string {
  return firstStringFromCandidates(collectCandidates(payload), keys);
}

function readNumberFromPayload(payload: unknown, keys: string[]): number | undefined {
  return readNumberFromCandidates(collectCandidates(payload), keys);
}

function readNumberFromCandidates(candidates: Array<Record<string, unknown>>, keys: string[]): number | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = readNumber(candidate[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function readNestedVideoNumber(candidates: Array<Record<string, unknown>>, key: string): number | undefined {
  for (const candidate of candidates) {
    const video = candidate.video;
    if (isRecord(video)) {
      const value = readNumber(video[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/%$/, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readProgress(candidates: Array<Record<string, unknown>>, status: VideoGenerationStatus["status"]): number {
  if (status === "done") return 100;
  for (const candidate of candidates) {
    for (const key of ["progress", "progress_percent", "progressPercentage", "percentage", "percent"]) {
      const raw = candidate[key];
      const value = readNumber(raw)
        ?? (isRecord(raw) ? readNumber(raw.percent) ?? readNumber(raw.percentage) ?? readNumber(raw.value) : undefined);
      if (value === undefined) continue;
      const normalized = typeof raw === "string" && raw.trim().endsWith("%")
        ? value
        : value > 0 && value < 1
          ? value * 100
          : value;
      return clampProgress(normalized);
    }
  }
  return 0;
}

function readURL(payload: unknown): string {
  const candidates = collectCandidates(payload);
  for (const candidate of candidates) {
    for (const key of ["video_url", "videoUrl", "output_url", "outputUrl", "download_url", "downloadUrl", "url"]) {
      const value = candidate[key];
      const url = readURLValue(value);
      if (url) return url;
    }
    const video = readURLValue(candidate.video);
    if (video) return video;
    const output = readURLValue(candidate.output);
    if (output) return output;
  }
  return "";
}

function readURLValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return "";
  return firstString(
    value.url,
    value.video_url,
    value.videoUrl,
    value.output_url,
    value.download_url,
    value.content_url,
    value.file_url,
    value.uri,
    value.href,
  );
}

function readVideoError(candidates: Array<Record<string, unknown>>): { code?: string; message: string } | null {
  for (const candidate of candidates) {
    const raw = candidate.error;
    if (typeof raw === "string" && raw.trim()) {
      return { code: firstString(candidate.code) || undefined, message: raw.trim() };
    }
    if (isRecord(raw)) {
      const parsed = readError(raw);
      if (parsed.message) return { code: parsed.code, message: parsed.message };
    }
    const parsed = readError(candidate);
    const state = firstString(candidate.status, candidate.state, candidate.phase).toLowerCase();
    if (parsed.message && ["failed", "failure", "error", "expired", "cancelled", "canceled", "rejected"].includes(state)) {
      return { code: parsed.code, message: parsed.message };
    }
  }
  return null;
}

function normalizeStatus(raw: string, hasVideo: boolean, hasError: boolean): VideoGenerationStatus["status"] {
  if (hasError || ["failed", "failure", "error", "expired", "cancelled", "canceled", "rejected", "aborted"].includes(raw)) return "failed";
  if (hasVideo || ["done", "complete", "completed", "succeeded", "successful", "success", "finished", "ready"].includes(raw)) return "done";
  return "pending";
}

function isTerminal(status: VideoGenerationStatus): boolean {
  return status.status === "done" || status.status === "failed";
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function resolveMediaURL(value: string, baseURL: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
  try {
    return new URL(trimmed, `${baseURL.replace(/\/+$/, "")}/`).toString();
  } catch {
    return trimmed;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("操作已取消", "AbortError");
}

function waitWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const delay = Math.max(0, milliseconds);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("操作已取消", "AbortError"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
