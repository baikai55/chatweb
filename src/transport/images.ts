import type { Backend } from "@/backends/types";
import {
  imageRouteFor,
  imageRouteSupportsInputImages,
  resolveImageRoute,
  selectByPath,
  type ResolvedImageRoute,
} from "@/transport/image-routes";
import {
  TransportError,
  firstString,
  isAbortError,
  isRecord,
  parseJSON,
  readError,
  toTransportError,
} from "@/transport/errors";
import { isErrorFrame, readSSE, type SSEFrame } from "@/transport/sse";
import { createRequestTimeoutScope, TimeoutError } from "@/transport/request-timeout";
import type { ImageResult } from "@/transport/types";

export type ImageResponseFormat = "url" | "b64_json";

export type GenerateImagesOptions = {
  backend: Backend;
  model: string;
  prompt: string;
  /** 参考图。对话路由发送多模态 content，标准图片路由改走 `/images/edits`。 */
  inputImages?: string[];
  n: number;
  /** size 与 aspectRatio 只会发送其中一个；同时提供时优先 size。 */
  size?: string;
  aspectRatio?: string;
  quality?: string;
  /**
   * 不填就整个不发 `response_format`。
   *
   * 有的上游多了这个键直接 400 —— 实测经 litellm 转发的 agnes：
   * `UnsupportedParamsError: Setting response_format is not supported by
   * openai, agnes-t2i-general-model`。而它又不像 size/quality 那样留空就能被
   * 模板剪掉（值必填，永远有），所以得允许显式不发。
   */
  responseFormat?: ImageResponseFormat;
  /** 上游多久没吐字节算卡死。由设置页的「图片等待上限」给，默认 300 秒。 */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** SSE 每返回一张完成图就通知 UI；不会把 partial_image 预览混进最终结果。 */
  onUpdate?: (images: ImageResult[]) => void;
};

/**
 * OpenAI 兼容的图片生成适配器。
 *
 * 具体打哪个端点、请求体长什么样，由后端配置的图片路由决定
 * （见 `src/transport/image-routes.ts`）—— 有的模型只认 `/images/generations`，
 * 有的只认 `chat/completions`，这个差异从模型 id 推断不出来。
 *
 * 响应侧无论走哪条路由都一样处理：可能是普通 JSON，可能是 SSE，也可能是
 * text/plain 里塞了 SSE 帧；标准 data 数组还常被包在 result / response / output
 * 等层级里。这里统一收敛成只含可直接展示 URL（远程 URL 或 data URL）的 ImageResult[]。
 */
export async function generateImages(options: GenerateImagesOptions): Promise<ImageResult[]> {
  const model = options.model.trim();
  const prompt = options.prompt.trim();
  if (!model) throw new TransportError(0, "请选择图片模型", "invalid_request");
  if (!prompt) throw new TransportError(0, "请输入图片描述", "invalid_request");
  if (!Number.isInteger(options.n) || options.n < 1 || options.n > 10) {
    throw new TransportError(0, "生成数量必须是 1 到 10 之间的整数", "invalid_request");
  }

  const requestTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IMAGE_IDLE_TIMEOUT_MS;
  const inputImages = options.inputImages?.map((url) => url.trim()).filter(Boolean) ?? [];
  if (inputImages.length > 16) {
    throw new TransportError(0, "参考图不能超过 16 张", "invalid_request");
  }
  const routeDefinition = imageRouteFor(options.backend, model);
  if (inputImages.length > 0 && !imageRouteSupportsInputImages(routeDefinition)) {
    throw new TransportError(0, "当前图片路由没有配置参考图输入", "unsupported_image_input");
  }

  const standardEdit = inputImages.length > 0 && routeDefinition.id === "images";
  const routedInputImages = standardEdit
    ? inputImages
    : await Promise.all(inputImages.map((url, index) => (
        normalizeJSONInputImage(url, index, options.signal, requestTimeoutMs)
      )));

  const route = resolveImageRoute(options.backend, {
    model,
    prompt,
    inputImages: routedInputImages,
    n: options.n,
    size: options.size,
    aspectRatio: options.aspectRatio,
    quality: options.quality,
    responseFormat: options.responseFormat,
  });

  const requestURL = standardEdit
    ? imageEditURL(options.backend.baseURL)
    : route.url;
  const requestBody = standardEdit
    ? await buildImageEditBody({ ...options, model, prompt, inputImages, requestTimeoutMs })
    : route.body;

  const headers = new Headers({ Accept: "application/json, text/event-stream" });
  if (requestBody !== null && !(requestBody instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.backend.apiKey) {
    headers.set("Authorization", `Bearer ${options.backend.apiKey}`);
  }

  const request = createRequestTimeoutScope(options.signal);
  try {
    const response = await request.run(() => fetch(requestURL, {
      method: route.method,
      headers,
      body: requestBody,
      signal: request.signal,
    }), requestTimeoutMs, "连接图片生成接口");

    if (!response.ok) {
      const errorText = await request.run(() => response.text(), requestTimeoutMs, "读取图片错误响应");
      throw toTransportError(response, errorText);
    }

    const extract = extractorFor(route);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return await consumeImageStream(response, options.backend.baseURL, extract, options.onUpdate, requestTimeoutMs);
    }

    const responseText = await request.run(() => response.text(), requestTimeoutMs, "读取图片生成响应");
    const frames = readBufferedFrames(responseText);
    if (frames.length > 0) {
      return consumeBufferedFrames(response, frames, options.backend.baseURL, extract, options.onUpdate);
    }

    const payload = parseJSON(responseText);
    if (payload !== null) {
      throwForPayloadError(response, undefined, payload);
      const images = extract(payload, options.backend.baseURL);
      if (images.length > 0) return images;
    } else {
      // 极少数兼容层直接把一条图片 URL 作为纯文本返回。
      const images = readImagesDeep(responseText.trim(), options.backend.baseURL);
      if (images.length > 0) return images;
    }

    throw new TransportError(response.status, "上游没有返回任何可显示的图片", "empty_response");
  } finally {
    request.dispose();
  }
}

type ImageEditBodyOptions = Omit<GenerateImagesOptions, "backend" | "signal" | "onUpdate" | "idleTimeoutMs"> & {
  inputImages: string[];
  requestTimeoutMs: number;
};

async function buildImageEditBody(options: ImageEditBodyOptions & { signal?: AbortSignal }): Promise<FormData> {
  const body = new FormData();
  body.set("model", options.model);
  body.set("prompt", options.prompt);
  body.set("n", String(options.n));
  if (options.size) body.set("size", options.size);
  else if (options.aspectRatio) body.set("aspect_ratio", options.aspectRatio);
  if (options.quality) body.set("quality", options.quality);
  if (options.responseFormat) body.set("response_format", options.responseFormat);

  const images = await Promise.all(options.inputImages.map((url, index) => (
    loadReferenceImage(url, index, options.signal, options.requestTimeoutMs)
  )));
  const field = images.length === 1 ? "image" : "image[]";
  for (const image of images) body.append(field, image.blob, image.name);
  return body;
}

async function loadReferenceImage(
  source: string,
  index: number,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_IMAGE_IDLE_TIMEOUT_MS,
): Promise<{ blob: Blob; name: string }> {
  const request = createRequestTimeoutScope(signal);
  let response: Response;
  try {
    response = await request.run(() => fetch(source, { signal: request.signal }), timeoutMs, "读取参考图片");
  } catch (caught) {
    request.dispose();
    if (signal?.aborted || isAbortError(caught) || caught instanceof TimeoutError) throw caught;
    throw new TransportError(
      0,
      "无法读取参考图片。若它来自外部链接，请先下载后再粘贴或上传。",
      "reference_image_unreadable",
    );
  }
  if (!response.ok) {
    request.dispose();
    throw new TransportError(response.status, `读取第 ${index + 1} 张参考图片失败`, "reference_image_unreadable");
  }

  try {
    const blob = await request.run(() => response.blob(), timeoutMs, "读取参考图片内容");
    const mime = blob.type.toLowerCase();
    if (mime && !mime.startsWith("image/")) {
      throw new TransportError(0, `第 ${index + 1} 个参考文件不是图片`, "invalid_reference_image");
    }
    return { blob, name: `reference-${index + 1}.${imageFileExtension(mime)}` };
  } finally {
    request.dispose();
  }
}

function imageEditURL(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/images/edits`;
}

function imageFileExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  const extension = /^image\/([a-z0-9.+-]+)$/i.exec(mime)?.[1];
  return extension && /^[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : "png";
}

/** blob: URL 只能在当前页面读取，JSON 发到上游前必须变成 data URL。 */
async function normalizeJSONInputImage(
  source: string,
  index: number,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_IMAGE_IDLE_TIMEOUT_MS,
): Promise<string> {
  if (!source.toLowerCase().startsWith("blob:")) return source;
  const { blob } = await loadReferenceImage(source, index, signal, timeoutMs);
  return readBlobAsDataURL(blob.type ? blob : blob.slice(0, blob.size, "image/png"), signal);
}

function readBlobAsDataURL(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = (): void => {
      reader.abort();
      reject(new DOMException("请求已取消", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    reader.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new TransportError(0, "读取参考图片失败", "reference_image_unreadable"));
    };
    reader.onload = () => {
      signal?.removeEventListener("abort", abort);
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result.startsWith("data:image/")) {
        reject(new TransportError(0, "参考图片无法转换为图片数据", "reference_image_unreadable"));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

type ImageExtractor = (payload: unknown, baseURL: string) => ImageResult[];

/**
 * 路由填了取图路径就按路径取，没填就用通用深度提取。
 *
 * 路径取空时回落到深度提取 —— 路径写错一个字就什么都拿不到，
 * 而"上游没返回图片"这个报错完全指不到是配置写错了。
 */
function extractorFor(route: ResolvedImageRoute): ImageExtractor {
  if (route.imageUrlPaths.length === 0 && route.b64JsonPaths.length === 0) {
    return readImagesDeep;
  }
  return (payload, baseURL) => {
    const byPath = extractByPaths(payload, baseURL, route);
    return byPath.length > 0 ? byPath : readImagesDeep(payload, baseURL);
  };
}

function extractByPaths(payload: unknown, baseURL: string, route: ResolvedImageRoute): ImageResult[] {
  const images: ImageResult[] = [];
  const seen = new Set<string>();

  const push = (url: string): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({ url });
  };

  for (const path of route.imageUrlPaths) {
    for (const value of selectByPath(payload, path)) {
      if (typeof value === "string" && value.trim()) {
        push(resolveImageURL(value.trim(), baseURL));
      } else if (isRecord(value)) {
        const nested = firstString(value.url, value.uri);
        if (nested) push(resolveImageURL(nested, baseURL));
      }
    }
  }

  for (const path of route.b64JsonPaths) {
    for (const value of selectByPath(payload, path)) {
      if (typeof value === "string" && value.trim()) {
        push(toImageDataURL(value.trim(), "image/png"));
      }
    }
  }

  return images;
}

/**
 * 图片流的静默超时默认比通用的 90 秒宽得多。
 *
 * 实测生成本来就慢（`gpt-image-2` 单张 68 秒，`quality:"high"` 到 103 秒），
 * 而且 CPA 会在上游失败时自己换一家重试 —— 使用日志里看得到
 * 「HTTP 499 context canceled」后面紧跟一条成功记录，那是 CPA 取消了
 * 第一家上游又打了第二家，两次加起来的静默时间轻松超过 90 秒。
 * 具体多少合适取决于你接的是哪家上游，所以做成了设置项。
 */
const DEFAULT_IMAGE_IDLE_TIMEOUT_MS = 300_000;

async function consumeImageStream(
  response: Response,
  baseURL: string,
  extract: ImageExtractor,
  onUpdate?: (images: ImageResult[]) => void,
  idleTimeoutMs = DEFAULT_IMAGE_IDLE_TIMEOUT_MS,
): Promise<ImageResult[]> {
  const images: ImageResult[] = [];
  const seen = new Set<string>();

  for await (const frame of readSSE(response, { idleTimeoutMs })) {
    if (frame.data.trim() === "[DONE]") break;
    const payload = parseJSON(frame.data);
    throwForPayloadError(response, frame, payload);
    if (payload === null || isPartialFrame(frame, payload)) continue;
    appendUnique(images, seen, extract(payload, baseURL));
    if (images.length > 0) onUpdate?.([...images]);
  }

  if (images.length === 0) {
    throw new TransportError(response.status, "图片流已结束，但没有返回完成的图片", "empty_response");
  }
  return images;
}

function consumeBufferedFrames(
  response: Response,
  frames: SSEFrame[],
  baseURL: string,
  extract: ImageExtractor,
  onUpdate?: (images: ImageResult[]) => void,
): ImageResult[] {
  const images: ImageResult[] = [];
  const seen = new Set<string>();

  for (const frame of frames) {
    if (frame.data.trim() === "[DONE]") break;
    const payload = parseJSON(frame.data);
    throwForPayloadError(response, frame, payload);
    if (payload === null || isPartialFrame(frame, payload)) continue;
    appendUnique(images, seen, extract(payload, baseURL));
    if (images.length > 0) onUpdate?.([...images]);
  }

  if (images.length === 0) {
    throw new TransportError(response.status, "图片流已结束，但没有返回完成的图片", "empty_response");
  }
  return images;
}

function appendUnique(target: ImageResult[], seen: Set<string>, incoming: ImageResult[]): void {
  for (const image of incoming) {
    if (seen.has(image.url)) continue;
    seen.add(image.url);
    target.push(image);
  }
}

function throwForPayloadError(response: Response, frame: SSEFrame | undefined, payload: unknown): void {
  const type = isRecord(payload) ? firstString(payload.type).toLowerCase() : "";
  const status = isRecord(payload) ? firstString(payload.status).toLowerCase() : "";
  const hasError = isRecord(payload) && payload.error !== undefined && payload.error !== null;
  const failed = type === "error" || type.endsWith(".failed") || status === "failed";
  if (!(frame && isErrorFrame(frame, payload)) && !hasError && !failed) return;

  const parsed = readError(payload);
  throw new TransportError(
    response.status,
    parsed.message ?? "图片生成在处理中失败了",
    parsed.code ?? "stream_error",
    parsed.requestId,
  );
}

function isPartialFrame(frame: SSEFrame, payload: unknown): boolean {
  if (frame.event?.toLowerCase().includes("partial_image")) return true;
  if (!isRecord(payload)) return false;
  const type = firstString(payload.type).toLowerCase();
  return type.includes("partial_image") || payload.partial_image_b64 !== undefined;
}

/**
 * 从标准或常见非标准嵌套响应中提取图片。
 *
 * 支持：
 *   - { data: [{ url | b64_json }] }
 *   - { images/results/output: [...] } 以及任意额外包装层
 *   - Responses 图片工具的 output[].result(base64)
 *   - SSE completed 事件顶层的 url / b64_json
 */
export function readImages(payload: unknown, baseURL: string): ImageResult[] {
  const images: ImageResult[] = [];
  const seenURLs = new Set<string>();
  const seenObjects = new WeakSet<object>();

  const push = (url: string, revisedPrompt?: string): void => {
    const normalized = resolveImageURL(url, baseURL);
    if (!normalized || seenURLs.has(normalized)) return;
    seenURLs.add(normalized);
    images.push({ url: normalized, revisedPrompt: revisedPrompt || undefined });
  };

  const visit = (value: unknown, contextKey: string, depth: number): void => {
    if (depth > 10 || value === null || value === undefined) return;

    if (typeof value === "string") {
      const raw = value.trim();
      if (!raw) return;
      if (isKnownImageBase64(raw) || (isBase64Context(contextKey) && !isImageURL(raw) && looksLikeBase64(raw))) {
        push(toImageDataURL(raw, "image/png"));
      } else if (isImageURL(raw)) {
        push(raw);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, contextKey, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    const revisedPrompt = firstString(value.revised_prompt, value.revisedPrompt);
    const mimeType = imageMimeType(firstString(
      value.mime_type,
      value.mimeType,
      value.content_type,
      value.contentType,
      value.output_format,
      value.outputFormat,
    ));
    const consumed = new Set<string>();

    for (const key of URL_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) {
        const raw = candidate.trim();
        if (isImageURL(raw)) push(raw, revisedPrompt);
        else if (looksLikeBase64(raw)) push(toImageDataURL(raw, mimeType), revisedPrompt);
        consumed.add(key);
      } else if (isRecord(candidate)) {
        const nestedURL = firstString(candidate.url, candidate.uri);
        if (nestedURL) push(nestedURL, revisedPrompt);
        consumed.add(key);
      }
    }

    for (const key of BASE64_KEYS) {
      const candidate = value[key];
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const raw = candidate.trim();
      if (raw.startsWith("data:image/")) push(raw, revisedPrompt);
      else if (isBase64Payload(raw)) push(toImageDataURL(raw, mimeType), revisedPrompt);
      consumed.add(key);
    }

    // Responses API 的 image_generation_call 把最终图片放在 result 字符串里。
    if (typeof value.result === "string" && isBase64Payload(value.result.trim())) {
      push(toImageDataURL(value.result.trim(), mimeType), revisedPrompt);
      consumed.add("result");
    }

    for (const [key, child] of Object.entries(value)) {
      if (consumed.has(key) || SKIP_RECURSION_KEYS.has(key)) continue;
      if (typeof child === "object" && child !== null) {
        visit(child, key, depth + 1);
      } else if (typeof child === "string" && isImageContainerKey(key)) {
        visit(child, key, depth + 1);
      }
    }
  };

  visit(payload, "root", 0);
  return images;
}

/**
 * 通用提取：结构化提取 + 正文里的 markdown 图片。
 *
 * 走 chat/completions 生图时，图片经常不在任何结构化字段里，而是
 * 拼在回复正文里的 `![](https://…)`。`readImages` 只认字段，扫不到这种。
 */
export function readImagesDeep(payload: unknown, baseURL: string): ImageResult[] {
  const images = readImages(payload, baseURL);
  const seen = new Set(images.map((image) => image.url));

  for (const text of collectText(payload)) {
    for (const url of readImageURLsFromText(text)) {
      const normalized = resolveImageURL(url, baseURL);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      images.push({ url: normalized });
    }
  }

  return images;
}

/** 只扫这几个键下的字符串，免得把错误信息里的 URL 也当成图片。 */
const TEXT_KEYS = new Set(["content", "text", "output_text", "markdown"]);

function collectText(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 10) return;
    if (typeof value === "string") {
      if (TEXT_KEYS.has(key) && value.trim()) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };

  visit(payload, "root", 0);
  return out;
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const DATA_IMAGE_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
// 裸 URL 只收有图片扩展名的 —— 没扩展名的链接扫进来误报太多
const BARE_IMAGE_URL = /https?:\/\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>"')\]]*)?/gi;

function readImageURLsFromText(text: string): string[] {
  const urls: string[] = [];
  for (const pattern of [MARKDOWN_IMAGE, DATA_IMAGE_URL, BARE_IMAGE_URL]) {
    for (const match of text.matchAll(pattern)) {
      const url = (match[1] ?? match[0]).trim();
      if (url) urls.push(url);
    }
  }
  return urls;
}

const URL_KEYS = ["url", "uri", "image_url", "imageUrl"] as const;
const BASE64_KEYS = [
  "b64_json",
  "b64",
  "base64",
  "base64_json",
  "image_base64",
  "imageBase64",
  "partial_image_b64",
] as const;
const SKIP_RECURSION_KEYS = new Set([
  "error",
  "usage",
  "request",
  "input",
  "model",
  "prompt",
  "revised_prompt",
  "revisedPrompt",
]);
const IMAGE_CONTAINER_KEYS = new Set([
  "data",
  "image",
  "images",
  "generated_image",
  "generated_images",
  "generatedImage",
  "generatedImages",
  "result",
  "results",
  "output",
  "outputs",
  "response",
  "content",
  "artifact",
  "artifacts",
  "prediction",
  "predictions",
  "payload",
]);

function isImageContainerKey(key: string): boolean {
  return IMAGE_CONTAINER_KEYS.has(key);
}

function isBase64Context(key: string): boolean {
  return BASE64_KEYS.includes(key as (typeof BASE64_KEYS)[number]) || isImageContainerKey(key);
}

function isImageURL(value: string): boolean {
  return /^(?:https?:|data:image\/|blob:|\/|\.\.?\/)/i.test(value);
}

function looksLikeBase64(value: string): boolean {
  if (value.startsWith("data:image/")) return true;
  const compact = value.replaceAll(/\s+/g, "");
  if (!isBase64Payload(compact)) return false;
  // 很短且没有 padding 的普通单词不应被当成图片；真实图片编码远大于此。
  return compact.length >= 16 || compact.endsWith("=");
}

function isBase64Payload(value: string): boolean {
  const compact = value.replaceAll(/\s+/g, "");
  return compact.length >= 4 && compact.length % 4 !== 1 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact);
}

function isKnownImageBase64(value: string): boolean {
  const compact = value.replaceAll(/\s+/g, "");
  return /^(?:iVBORw0KGgo|\/9j\/|UklGR|R0lGOD|AAAA(?:IGZ0eXBhdmlm|HGZ0eXBhdmlm))/.test(compact);
}

function imageMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  if (normalized === "avif") return "image/avif";
  return "image/png";
}

function toImageDataURL(value: string, mimeType: string): string {
  if (value.startsWith("data:image/")) return value;
  const compact = value.replaceAll(/\s+/g, "");
  const detected = compact.startsWith("/9j/")
    ? "image/jpeg"
    : compact.startsWith("UklGR")
      ? "image/webp"
      : compact.startsWith("R0lGOD")
        ? "image/gif"
        : compact.startsWith("iVBORw0KGgo")
          ? "image/png"
          : mimeType;
  return `data:${detected};base64,${compact}`;
}

function resolveImageURL(value: string, baseURL: string): string {
  const url = value.trim();
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
  try {
    return new URL(url, `${baseURL.replace(/\/+$/, "")}/`).toString();
  } catch {
    return url;
  }
}

/** text/plain 下也有后端输出 SSE / NDJSON；整包读完后按帧兼容。 */
function readBufferedFrames(responseText: string): SSEFrame[] {
  const normalized = responseText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const frames: SSEFrame[] = [];

  for (const block of normalized.split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  if (frames.length > 0) return frames;

  // 没有 data: 前缀时再尝试一行一个 JSON 的 NDJSON。
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => line === "[DONE]" || parseJSON(line) !== null)) {
    return lines.map((data) => ({ data }));
  }
  return [];
}
