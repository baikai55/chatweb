import { TransportError, isRecord, parseJSON, toTransportError, firstString } from "@/transport/errors";
import { isErrorFrame, readSSE } from "@/transport/sse";
import type { ChatRequestOptions, ChatStreamResult, ChatStreamSnapshot, ChatToolActivity, ReasoningEffort } from "@/transport/types";

/**
 * OpenAI chat/completions 适配器。
 *
 * 这是覆盖面最广的协议 —— CPA、grok2api、chatgpt2api 以及几乎所有 2api 项目都支持它。
 * 优先用它，Responses 协议只在需要它独有能力（prompt_cache_key 等）时才走。
 */

/** 后端方言。用响应头确定性识别，不靠猜。 */
export type BackendFlavor = "cpa" | "grok2api" | "generic";

export type ChatCompletionsOptions = ChatRequestOptions & {
  flavor?: BackendFlavor;
  /** 当前模型属于哪家上游。决定联网搜索用什么形状的 tools。 */
  vendor?: string;
};

export async function streamChatCompletions(options: ChatCompletionsOptions): Promise<ChatStreamResult> {
  const flavor = options.flavor ?? "generic";
  const body = buildRequestBody(options, flavor);

  const response = await fetch(joinURL(options.baseURL, "/chat/completions"), {
    method: "POST",
    headers: new Headers({
      Accept: "text/event-stream",
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw toTransportError(response, await response.text());
  }

  // 少数后端在 stream:true 下仍返回整包 JSON，兼容一下
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return readNonStreamResponse(response, await response.text());
  }

  return consumeStream(response, options.onUpdate);
}

function buildRequestBody(options: ChatCompletionsOptions, flavor: BackendFlavor): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: applyReasoningToModel(options.model, options.reasoningEffort, flavor),
    messages: options.messages.map(({ role, content }) => ({ role, content })),
    stream: true,
  };

  // CPA 用模型名后缀控制推理档位（优先级高于 reasoning_effort），已经在 model 里带上了。
  // 其余后端走标准字段。
  if (flavor !== "cpa" && options.reasoningEffort !== "auto") {
    body.reasoning_effort = options.reasoningEffort;
  }

  const tools = buildTools(options);
  if (tools.length > 0) body.tools = tools;

  return body;
}

/**
 * CPA 独有语法：模型名后缀 `model(value)`，优先级高于 body 里的 reasoning_effort。
 * 覆盖面比标准字段广 —— Gemini 的 token 预算模式只能靠它。
 * 见 CLIProxyAPI internal/thinking/suffix.go:23-44 与 apply.go:253-256。
 */
function applyReasoningToModel(model: string, effort: ReasoningEffort, flavor: BackendFlavor): string {
  if (flavor !== "cpa") return model;
  if (effort === "auto") return model;
  // 模型名里已经有后缀了就不动它，尊重用户手写
  if (/\([^)]*\)\s*$/.test(model)) return model;
  return `${model}(${effort})`;
}

/**
 * 联网搜索在 CPA 上是不对称的：
 *   Gemini 系  → tools:[{google_search:{}}] 会被透传成原生 googleSearch
 *   Claude 系  → 经 chat/completions 会被 type=="function" 硬过滤静默丢弃，
 *                必须走 /v1/messages 原生协议才能用 web_search
 * 见 CLIProxyAPI gemini_openai_request.go:372 与 claude_openai_request.go:323。
 */
function buildTools(options: ChatCompletionsOptions): Array<Record<string, unknown>> {
  if (!options.webSearch) return [];
  const vendor = (options.vendor ?? inferVendor(options.model)).toLowerCase();
  if (vendor === "gemini") return [{ google_search: {} }];
  if (vendor === "grok" || vendor === "xai") return [{ type: "web_search" }];
  // Claude / GPT 等经 chat/completions 用不了内置搜索，不发无效字段
  return [];
}

export function inferVendor(model: string): string {
  const id = model.toLowerCase();
  if (id.includes("gemini") || id.includes("imagen")) return "gemini";
  if (id.includes("claude")) return "claude";
  if (id.includes("grok")) return "grok";
  if (id.includes("kimi")) return "kimi";
  if (id.includes("gpt") || id.includes("codex") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return "openai";
  return "unknown";
}

async function consumeStream(response: Response, onUpdate?: (snapshot: ChatStreamSnapshot) => void): Promise<ChatStreamResult> {
  let text = "";
  let reasoning = "";
  let nativeFinishReason: string | undefined;
  const tools = new Map<string, ChatToolActivity>();

  const snapshot = (): ChatStreamSnapshot => ({
    text,
    reasoning,
    tools: Array.from(tools.values()),
    nativeFinishReason,
  });

  for await (const frame of readSSE(response)) {
    if (frame.data === "[DONE]") break;

    const payload = parseJSON(frame.data);

    // event: error 帧的 payload 未必带可识别的 type，所以错误判定要看 event 名
    if (isErrorFrame(frame, payload)) {
      const parsed = readStreamError(payload);
      throw new TransportError(response.status, parsed || "流在中途失败了", "stream_error");
    }

    if (!isRecord(payload)) continue;

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
    if (!choice) continue;

    const native = firstString(choice.native_finish_reason, payload.native_finish_reason);
    if (native) nativeFinishReason = native;

    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (!delta) continue;

    if (typeof delta.content === "string") {
      text += delta.content;
    }

    const reasoningDelta = readReasoningDelta(delta);
    if (reasoningDelta) reasoning += reasoningDelta;

    if (Array.isArray(delta.tool_calls)) {
      applyToolCalls(tools, delta.tool_calls);
    }

    onUpdate?.(snapshot());
  }

  if (!text.trim() && !reasoning.trim() && tools.size === 0) {
    throw new TransportError(response.status, "上游没有返回任何可显示的内容", "empty_response");
  }
  return snapshot();
}

/**
 * 推理增量。
 *
 * 三个字段都要认，不能只认一个 —— CPA 有两条完全不同的路径：
 *
 *   1. 走自己翻译器的上游（Gemini / Claude / Codex / Antigravity / Kimi 官方凭证）
 *      → 归一成 reasoning_content，见 CLIProxyAPI 的 internal/translator 下各家
 *        openai/chat-completions 翻译器
 *   2. openai-compatibility 类型的第三方上游 → **原样透传，不翻译**，
 *      上游叫什么就是什么。实测 cpa.yueming.uk 上的 DeepSeek 第三方源返回的是
 *      `delta.reasoning`（响应体里带 service_tier / system_fingerprint，
 *      是典型的透传特征）。
 *
 * 所以顺序是：先认官方归一字段，再退到透传常见的两种命名。
 */
function readReasoningDelta(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  if (typeof delta.thinking === "string") return delta.thinking;
  return "";
}

function applyToolCalls(tools: Map<string, ChatToolActivity>, rawCalls: unknown[]): void {
  for (const raw of rawCalls) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === "number" ? raw.index : 0;
    const id = firstString(raw.id) || `tool-${index}`;
    const fn = isRecord(raw.function) ? raw.function : undefined;
    const current = tools.get(id) ?? {
      id,
      type: firstString(raw.type) || "function",
      name: "tool",
      status: "in_progress" as const,
      detail: "",
    };
    const name = firstString(fn?.name);
    const argsDelta = typeof fn?.arguments === "string" ? fn.arguments : "";
    tools.set(id, {
      ...current,
      name: name || current.name,
      detail: current.detail + argsDelta,
    });
  }
}

function readStreamError(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  const error = isRecord(payload.error) ? payload.error : payload;
  return firstString(error.message, payload.error, error.detail);
}

/** 少数后端忽略 stream:true，直接返回整包。 */
function readNonStreamResponse(response: Response, responseText: string): ChatStreamResult {
  const payload = parseJSON(responseText);
  if (!isRecord(payload)) {
    throw new TransportError(response.status, "上游返回了无法解析的响应", "invalid_response");
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;

  const text = firstString(message?.content);
  const reasoning = firstString(message?.reasoning_content, message?.reasoning, message?.thinking);
  if (!text && !reasoning) {
    throw new TransportError(response.status, "上游没有返回任何可显示的内容", "empty_response");
  }
  return {
    text,
    reasoning,
    tools: [],
    nativeFinishReason: firstString(choice?.native_finish_reason) || undefined,
  };
}

export function joinURL(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
