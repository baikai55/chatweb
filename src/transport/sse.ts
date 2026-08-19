import { TransportError } from "@/transport/errors";

/**
 * SSE 读取器。
 *
 * 为什么不用浏览器内置的 EventSource：
 *   1. 它不能带 Authorization 头
 *   2. 它只支持 GET
 *   3. 它对 `event: error` 帧的处理会吞掉 data
 *
 * 各后端的 SSE 约定互不相同，甚至同一后端内部都不一致：
 *
 *   grok2api /v1/responses      有 event: 行，有 [DONE]
 *   chatgpt2api /v1/responses    没有 event: 行，有 [DONE]
 *   chatgpt2api /v1/images/*     有 event: 行，没有 [DONE]
 *   各家 /v1/chat/completions    没有 event: 行，有 [DONE]
 *
 * 所以规则是：**派发一律看 payload 里的字段，永远不靠 event 名来分支。**
 * 但 event 名不是完全没用 —— CPA 的错误帧是 `event: error\ndata: {...}`，
 * 而那个 data 的 payload 未必带能识别的 type 字段。丢掉 event 名就会把
 * 一个失败的流当成正常结束。所以这里把 event 名原样透出，
 * 由调用方用它做**错误判定**（而非派发）。
 */

export type SSEFrame = {
  /** SSE 的 event: 行。只用来判断是不是错误帧，不要用它派发业务逻辑。 */
  event?: string;
  /** 拼接后的 data: 内容。注释帧和空帧不会产生 SSEFrame。 */
  data: string;
};

export type SSEOptions = {
  /** 上游多久没发任何字节就判定为卡死。默认 90 秒。 */
  idleTimeoutMs?: number;
  /** 单帧缓冲上限，防止畸形响应吃光内存。默认 8MB。 */
  maxBufferBytes?: number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * 逐帧读取 SSE 流。
 *
 * 自动跳过：
 *   - `: keep-alive` 之类的注释帧（CPA 在 streaming.keepalive-seconds > 0 时会发）
 *   - `: stream-open` 首帧（chatgpt2api 会发）
 *   - 只有 event: 没有 data: 的帧
 *
 * 不自动处理 `[DONE]` —— 交给调用方，因为有的后端根本不发它。
 */
export async function* readSSE(response: Response, options: SSEOptions = {}): AsyncGenerator<SSEFrame> {
  if (!response.body) {
    throw new TransportError(response.status, "上游返回了空的流");
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);

      buffer += decoder.decode(value, { stream: !done });
      // 统一换行，SSE 规范允许 \r\n / \r / \n 三种
      // 网络分块可以恰好切在 CR 和 LF 之间。流还没结束时先保留末尾孤立的 CR，
      // 否则这一轮把 CR 变成 LF、下一轮再拼入 LF，会凭空造出一个帧边界。
      const trailingCR = !done && buffer.endsWith("\r");
      const complete = trailingCR ? buffer.slice(0, -1) : buffer;
      buffer = complete.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
        + (trailingCR ? "\r" : "");

      if (buffer.length > maxBufferBytes) {
        throw new TransportError(response.status, `上游单帧超过 ${Math.round(maxBufferBytes / 1024 / 1024)}MB，已中断`);
      }

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = parseFrame(buffer.slice(0, boundary));
        if (frame) yield frame;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    // 有的后端结束时不补最后那个空行
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    // 提前 return（调用方 break 出循环）时要主动放掉底层连接
    reader.cancel().catch(() => {});
  }
}

function parseFrame(block: string): SSEFrame | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    // 注释帧（心跳）。`:` 开头即为注释，整行丢弃。
    if (line.startsWith(":")) continue;

    if (line.startsWith("data:")) {
      dataLines.push(stripOneLeadingSpace(line.slice(5)));
      continue;
    }
    if (line.startsWith("event:")) {
      event = stripOneLeadingSpace(line.slice(6)).trim();
      continue;
    }
    // id: / retry: 等字段用不上，忽略
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** SSE 规范：字段名冒号后如果紧跟一个空格，这个空格要去掉，且只去一个。 */
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new TransportError(408, `上游超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有发送任何数据，已中断`));
    }, idleTimeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 判断一帧是不是错误帧。
 *
 * 两个来源：
 *   1. `event: error`（CPA 的 code_handlers.go:337、openai_images_handlers.go:104）
 *   2. payload 里带 type: "error" / "response.failed"（Responses 协议）
 */
export function isErrorFrame(frame: SSEFrame, payload: unknown): boolean {
  if (frame.event && frame.event.toLowerCase() === "error") return true;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const type = (payload as Record<string, unknown>).type;
    if (type === "error" || type === "response.failed") return true;
  }
  return false;
}
