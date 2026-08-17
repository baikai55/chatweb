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
    text = await readTextBodyWithLimit(request.body, request.headers, maxBytes);
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
  return readTextBodyWithLimit(response.body, response.headers, maxBytes);
}

async function readTextBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");

  const declaredLength = parseContentLength(headers.get("Content-Length"));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelBody(body);
    throw new BodyTooLargeError();
  }
  if (!body) return "";

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
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return;
  await body.cancel().catch(() => undefined);
}
