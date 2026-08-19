import { TransportError } from "@/transport/errors";

/** 普通 API 请求建立连接，以及读取一段 JSON/文本响应的默认上限。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** 语音生成、转写和二进制音频响应允许更长的处理时间。 */
export const DEFAULT_MEDIA_REQUEST_TIMEOUT_MS = 120_000;

export class TimeoutError extends TransportError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, operation = "请求") {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    super(408, `${operation}超过 ${seconds} 秒，已中断`, "request_timeout");
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type RequestTimeoutScope = {
  /** 交给 fetch；它同时响应外部取消和当前阶段的超时。 */
  signal: AbortSignal;
  run<T>(operation: () => Promise<T>, timeoutMs: number, label?: string): Promise<T>;
  dispose(): void;
};

/**
 * 为一个请求生命周期组合外部取消和分阶段超时。
 *
 * fetch 返回响应头后可以结束“建连”计时，再对 response.text()/blob() 单独计时；
 * 两个阶段共用同一个 signal，因此正文超时时也能真正中止底层 fetch。
 */
export function createRequestTimeoutScope(externalSignal?: AbortSignal): RequestTimeoutScope {
  const controller = new AbortController();
  let disposed = false;

  const relayExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(externalSignal));
  };
  if (externalSignal?.aborted) relayExternalAbort();
  else externalSignal?.addEventListener("abort", relayExternalAbort, { once: true });

  return {
    signal: controller.signal,
    async run<T>(operation: () => Promise<T>, timeoutMs: number, label = "请求"): Promise<T> {
      throwIfAborted(controller.signal);
      const delay = normalizeTimeout(timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortReason(controller.signal));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      timer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new TimeoutError(delay, label));
      }, delay);

      try {
        return await Promise.race([operation(), aborted]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      externalSignal?.removeEventListener("abort", relayExternalAbort);
    },
  };
}

function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.round(timeoutMs));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("操作已取消", "AbortError");
}
