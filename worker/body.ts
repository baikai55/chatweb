export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

/** 按实际流入字节计数，避免伪造或省略 Content-Length 绕过内存上限。 */
export async function readJsonBodyWithLimit(request: Request, maxBytes: number): Promise<unknown> {
  let text: string;
  try {
    text = decodeUtf8(await readBodyWithLimit(request.body, request.headers, maxBytes));
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    throw new InvalidJsonBodyError();
  }

  if (!text) throw new InvalidJsonBodyError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  return decodeUtf8(await readBodyWithLimit(response.body, response.headers, maxBytes));
}

/** 按实际流入字节读取请求体，并在超过上限时立即取消流。 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");

  const declaredLength = readContentLength(headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelBody(body);
    throw new BodyTooLargeError();
  }
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * 上传兼容路径使用 Blob 保存分块，避免先拼一份 ArrayBuffer、再给 multipart
 * 解析器复制一份。裸 body 的正常路径会直接流入 R2，不经过这里。
 */
export async function readBlobWithLimit(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maxBytes: number,
): Promise<Blob> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");

  const declaredLength = readContentLength(headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelBody(body);
    throw new BodyTooLargeError();
  }
  if (!body) return new Blob();

  const reader = body.getReader();
  const chunks: ArrayBufferView[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

export function readContentLength(headers: Headers): number | null {
  const value = headers.get("Content-Length");
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return;
  await body.cancel().catch(() => undefined);
}
