import type { Env } from "./auth";

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

  const maxBytes = Number(env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;

  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (declaredLength > maxBytes) {
    return json({ error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
  }

  const file = await readFile(request);
  if (!file) return json({ error: "请求里没有找到文件" }, 400);
  if (file.byteLength === 0) return json({ error: "文件是空的" }, 400);
  if (file.byteLength > maxBytes) {
    return json({ error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` }, 413);
  }

  const detected = detectType(new Uint8Array(file.slice(0, 16)));
  if (!detected) {
    return json({ error: "只接受图片（png/jpg/gif/webp）和视频（mp4/webm/mov）" }, 415);
  }

  const key = `uploads/${datePrefix()}/${randomId()}.${detected.ext}`;
  await env.MEDIA.put(key, file, {
    httpMetadata: {
      contentType: detected.mime,
      cacheControl: `public, max-age=${env.MEDIA_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}`,
    },
  });

  return json({
    key,
    url: `${origin}/__api/media/${key}`,
    contentType: detected.mime,
    size: file.byteLength,
  });
}

export async function handleMediaRead(key: string, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: "未配置存储" }, 501);
  if (!isSafeKey(key)) return json({ error: "非法路径" }, 400);

  const object = await env.MEDIA.get(key);
  if (!object) return json({ error: "文件不存在或已过期" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set(
    "Cache-Control",
    `public, max-age=${env.MEDIA_CACHE_SECONDS ?? DEFAULT_CACHE_SECONDS}, immutable`,
  );
  // 上游（xAI 等）要跨域抓这个 URL
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(object.body, { headers });
}

/** 同时接受 multipart 表单和裸 body。手机端 <input type="file"> 走 multipart。 */
async function readFile(request: Request): Promise<ArrayBuffer | null> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const entry = form.get("file") ?? form.get("image") ?? form.get("video");
    if (entry instanceof File) return entry.arrayBuffer();
    return null;
  }
  return request.arrayBuffer();
}

function detectType(head: Uint8Array): { ext: string; mime: string } | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.test(head)) return { ext: signature.ext, mime: signature.mime };
  }
  return null;
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
