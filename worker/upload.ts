import type { Env } from "./auth";
import { BodyTooLargeError, readBlobWithLimit, readContentLength } from "./body";

/**
 * R2 上传通道。
 *
 * 为什么需要它：视频编辑和延长要先给上游一个**公网可达的源文件 URL**。
 * grok2api 的上传端点（/api/admin/v1/media/inputs/upload）是 admin-only，
 * 独立部署拿不到 admin 会话；公开路由只有读，没有写
 * （backend/internal/transport/http/media/handler.go:28-34）。所以自建一条。
 *
 * 手机场景是主要动机 —— 手机上没法"先传图床再复制链接"。
 */

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_CACHE_SECONDS = 7 * 24 * 60 * 60;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const TYPE_SNIFF_BYTES = 16;

class UploadLengthMismatchError extends Error {}

/** 只认这些类型，且按魔数校验而不是只看 Content-Type。 */
const MAGIC_SIGNATURES: Array<{ ext: string; mime: string; test: (bytes: Uint8Array) => boolean }> = [
  { ext: "png", mime: "image/png", test: (b) => match(b, [0x89, 0x50, 0x4e, 0x47]) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => match(b, [0xff, 0xd8, 0xff]) },
  { ext: "gif", mime: "image/gif", test: (b) => match(b, [0x47, 0x49, 0x46, 0x38]) },
  { ext: "webp", mime: "image/webp", test: (b) => match(b, [0x52, 0x49, 0x46, 0x46]) && match(b, [0x57, 0x45, 0x42, 0x50], 8) },
  { ext: "mp4", mime: "video/mp4", test: (b) => match(b, [0x66, 0x74, 0x79, 0x70], 4) },
  { ext: "webm", mime: "video/webm", test: (b) => match(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  { ext: "mov", mime: "video/quicktime", test: (b) => match(b, [0x66, 0x74, 0x79, 0x70, 0x71, 0x74], 4) },
];

function match(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export async function handleUpload(request: Request, env: Env, origin: string): Promise<Response> {
  if (!env.MEDIA) {
    return json({ error: "服务端没有配置 R2 存储桶，无法上传" }, 501);
  }

  const configuredMaxBytes = Number(env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES);
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : DEFAULT_MAX_UPLOAD_BYTES;

  let upload: PreparedUpload | null;
  try {
    upload = await prepareUpload(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }
    if (error instanceof UploadLengthMismatchError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
  if (!upload) return json({ error: "请求里没有找到文件" }, 400);
  if (upload.size === 0) return json({ error: "文件是空的" }, 400);
  if (upload.size !== null && upload.size > maxBytes) {
    return json({ error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
  }

  const detected = detectType(upload.head);
  if (!detected) {
    await upload.cancel();
    return json({ error: "只接受图片（png/jpg/gif/webp）和视频（mp4/webm/mov）" }, 415);
  }

  const key = `uploads/${datePrefix()}/${randomId()}.${detected.ext}`;
  let stored: R2Object | null;
  try {
    stored = await env.MEDIA.put(key, upload.value, {
      httpMetadata: mediaMetadata(detected.mime, env),
    });
  } catch (error) {
    await upload.cancel();
    if (upload.tooLarge()) {
      return json({ error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
    }
    if (upload.invalidLength()) {
      return json({ error: "上传正文长度与声明不一致" }, 400);
    }
    throw error;
  }
  const size = stored?.size ?? upload.bytesRead();

  return json({
    key,
    url: `${origin}/__api/media/${key}`,
    contentType: detected.mime,
    size,
  });
}

export async function handleMediaRead(request: Request, key: string, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: "未配置存储" }, 501);
  if (!isSafeKey(key)) return json({ error: "非法路径" }, 400);

  const metadata = await env.MEDIA.head(key);
  if (!metadata) return json({ error: "文件不存在或已过期" }, 404);

  const headers = mediaResponseHeaders(metadata, env);
  if (etagMatches(request.headers.get("If-None-Match"), metadata.httpEtag)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const requestedRange = parseByteRange(request.headers.get("Range"), metadata.size);
  if (requestedRange === "invalid") {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const object = await env.MEDIA.get(key, requestedRange ? { range: requestedRange } : undefined);
  if (!object) return json({ error: "文件不存在或已过期" }, 404);

  if (requestedRange) {
    const end = requestedRange.offset + requestedRange.length - 1;
    headers.set("Content-Range", `bytes ${requestedRange.offset}-${end}/${metadata.size}`);
    headers.set("Content-Length", String(requestedRange.length));
  }
  return new Response(object.body, {
    status: requestedRange ? 206 : 200,
    headers,
  });
}

function mediaResponseHeaders(object: R2Object, env: Env): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(object.size));
  headers.set(
    "Cache-Control",
    `public, max-age=${env.MEDIA_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}, immutable`,
  );
  // 上游（xAI 等）要跨域抓这个 URL
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

type PreparedUpload = {
  value: ReadableStream<Uint8Array> | Blob;
  head: Uint8Array;
  /** 流式路径在 R2 消费完成前不知道最终大小。 */
  size: number | null;
  bytesRead: () => number;
  tooLarge: () => boolean;
  invalidLength: () => boolean;
  cancel: () => Promise<void>;
};

/** 裸 body 是主路径；multipart 只为旧客户端保留。 */
async function prepareUpload(request: Request, maxBytes: number): Promise<PreparedUpload | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const requestLimit = Math.min(Number.MAX_SAFE_INTEGER, maxBytes + MAX_MULTIPART_OVERHEAD_BYTES);
    const requestBlob = await readBlobWithLimit(request.body, request.headers, requestLimit);
    const form = await new Response(requestBlob, {
      headers: { "Content-Type": contentType },
    }).formData();
    const entry = form.get("file") ?? form.get("image") ?? form.get("video");
    if (entry instanceof File) return preparedBlob(entry, maxBytes);
    return null;
  }

  const declaredLength = readUploadLength(request.headers);
  if (declaredLength !== null && declaredLength > maxBytes) throw new BodyTooLargeError();
  if (declaredLength === null) {
    return preparedBlob(await readBlobWithLimit(request.body, request.headers, maxBytes), maxBytes);
  }
  return prepareStreamingUpload(request.body, declaredLength, maxBytes);
}

async function preparedBlob(blob: Blob, maxBytes: number): Promise<PreparedUpload> {
  if (blob.size > maxBytes) throw new BodyTooLargeError();
  const head = new Uint8Array(await blob.slice(0, TYPE_SNIFF_BYTES).arrayBuffer());
  return {
    value: blob,
    head,
    size: blob.size,
    bytesRead: () => blob.size,
    tooLarge: () => false,
    invalidLength: () => false,
    cancel: async () => undefined,
  };
}

async function prepareStreamingUpload(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number,
  maxBytes: number,
): Promise<PreparedUpload> {
  if (!body) return preparedBlob(new Blob(), maxBytes);

  const reader = body.getReader();
  const initialChunks: Uint8Array[] = [];
  let initialBytes = 0;
  while (initialBytes < TYPE_SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    initialChunks.push(value);
    initialBytes += value.byteLength;
    if (initialBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
  }

  if (initialBytes === 0) {
    reader.releaseLock();
    return preparedBlob(new Blob(), maxBytes);
  }

  const head = copyPrefix(initialChunks, Math.min(initialBytes, TYPE_SNIFF_BYTES));
  const state = { bytesRead: 0, tooLarge: false, invalidLength: false };
  const limited = streamFromReader(reader, initialChunks, state, maxBytes, declaredLength);
  const value = withFixedLength(limited, declaredLength);
  return {
    value,
    head,
    size: null,
    bytesRead: () => state.bytesRead,
    tooLarge: () => state.tooLarge,
    invalidLength: () => state.invalidLength,
    cancel: () => value.cancel().catch(() => undefined),
  };
}

function streamFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialChunks: Uint8Array[],
  state: { bytesRead: number; tooLarge: boolean; invalidLength: boolean },
  maxBytes: number,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = index < initialChunks.length
        ? { done: false as const, value: initialChunks[index++] as Uint8Array }
        : await reader.read();
      if (next.done) {
        if (state.bytesRead !== expectedBytes) {
          state.invalidLength = true;
          controller.error(new Error("上传正文长度与 Content-Length 不一致"));
        } else {
          controller.close();
        }
        releaseReader(reader);
        return;
      }
      state.bytesRead += next.value.byteLength;
      if (state.bytesRead > maxBytes) {
        state.tooLarge = true;
        await reader.cancel().catch(() => undefined);
        releaseReader(reader);
        controller.error(new BodyTooLargeError());
        return;
      }
      if (state.bytesRead > expectedBytes) {
        state.invalidLength = true;
        await reader.cancel().catch(() => undefined);
        releaseReader(reader);
        controller.error(new Error("上传正文长度与 Content-Length 不一致"));
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason)
        .catch(() => undefined)
        .finally(() => releaseReader(reader));
    },
  });
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // 已释放或仍有 read 在途时无需二次处理。
  }
}

function withFixedLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === "undefined") return stream;
  return stream.pipeThrough(
    new FixedLengthStream(length) as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

function copyPrefix(chunks: Uint8Array[], length: number): Uint8Array {
  const prefix = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = length - offset;
    if (remaining <= 0) break;
    const copied = chunk.subarray(0, remaining);
    prefix.set(copied, offset);
    offset += copied.byteLength;
  }
  return prefix;
}

function readUploadLength(headers: Headers): number | null {
  const contentLength = readContentLength(headers);
  const explicitLength = headers.get("X-Upload-Length")?.trim() ?? "";
  if (!explicitLength) return contentLength;
  if (!/^\d+$/.test(explicitLength)) {
    throw new UploadLengthMismatchError("X-Upload-Length 必须是非负整数");
  }
  const parsed = Number(explicitLength);
  const uploadLength = Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
  if (contentLength !== null && contentLength !== uploadLength) {
    throw new UploadLengthMismatchError("Content-Length 与 X-Upload-Length 不一致");
  }
  return contentLength ?? uploadLength;
}

function detectType(head: Uint8Array): { ext: string; mime: string } | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.test(head)) return { ext: signature.ext, mime: signature.mime };
  }
  return null;
}

function mediaMetadata(contentType: string, env: Env): R2HTTPMetadata {
  return {
    contentType,
    cacheControl: `public, max-age=${env.MEDIA_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
  };
}

function etagMatches(header: string | null, current: string): boolean {
  if (!header) return false;
  const normalizedCurrent = current.replace(/^W\//i, "");
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//i, "") === normalizedCurrent;
  });
}

type ParsedRange = { offset: number; length: number } | "invalid" | null;

function parseByteRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return "invalid";

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start > requestedEnd || start >= size) {
    return "invalid";
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

/** 只允许我们自己生成的形状，杜绝路径穿越和越权读取。 */
function isSafeKey(key: string): boolean {
  return /^uploads\/\d{8}\/[a-z0-9]+\.[a-z0-9]+$/.test(key);
}

function datePrefix(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${now.getUTCFullYear()}${month}${day}`;
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
