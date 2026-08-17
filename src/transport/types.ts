/**
 * 协议层的统一类型。
 *
 * 不同后端说不同的话（chat/completions、Responses、Anthropic Messages），
 * 但 UI 只认这里定义的这一套。每个适配器负责把上游的方言翻译成 ChatStreamSnapshot。
 */

export type ChatRole = "system" | "user" | "assistant";

/**
 * OpenAI 兼容 chat/completions 的文本内容片段。
 *
 * 绝大多数旧后端只接受 `content: string`，支持视觉输入的后端则接受
 * `content: [{ type: "text", text: "..." }, { type: "image_url", ... }]`。
 * 两种形状都保留在统一协议类型里，适配器会原样透传，因而不会破坏旧会话。
 */
export type ChatTextContentPart = {
  type: "text";
  text: string;
};

/** OpenAI vision 兼容的图片内容片段。url 可以是 https 或 data:image/* URL。 */
export type ChatImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type ChatContentPart = ChatTextContentPart | ChatImageContentPart;
export type ChatMessageContent = string | ChatContentPart[];

export type ChatMessage = {
  role: ChatRole;
  content: ChatMessageContent;
};

/** OpenAI 兼容的 function tool 调用。只在一次请求的内部消息里使用，不写入聊天历史。 */
export type ChatFunctionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatAssistantToolMessage = {
  role: "assistant";
  content: string;
  tool_calls: ChatFunctionToolCall[];
};

export type ChatToolResultMessage = {
  role: "tool";
  content: string;
  tool_call_id: string;
  name?: string;
};

/** 发给上游的消息可以包含 function tool 循环产生的临时消息。 */
export type ChatRequestMessage = ChatMessage | ChatAssistantToolMessage | ChatToolResultMessage;

/**
 * 从字符串或多模态内容中取出可显示的文本。
 *
 * 上游的非流式响应偶尔也会把 `message.content` 包成 text part 数组；
 * 统一在这里解包，避免这种响应被误判成空回复。图片片段本身没有可显示
 * 的文字，会被自然忽略。
 */
export function readChatContentText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((part) => readChatContentText(part)).join("");
  }

  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;

  if (typeof record.text === "string") return record.text;
  if (typeof record.output_text === "string") return record.output_text;
  if ("content" in record) return readChatContentText(record.content);
  return "";
}

export type ReasoningEffort = "auto" | "none" | "low" | "medium" | "high" | "xhigh";

export type ChatToolActivity = {
  id: string;
  type: string;
  name: string;
  status: "in_progress" | "completed" | "failed";
  detail: string;
};

/**
 * 流式过程中的快照。适配器每收到一点增量就产出一个新快照，UI 直接渲染。
 * text / reasoning 是累积值而非增量，这样 UI 不需要自己维护拼接状态。
 */
export type ChatStreamSnapshot = {
  text: string;
  reasoning: string;
  tools: ChatToolActivity[];
  /** 仅供 transport 内部继续 function tool 循环；UI 不需要持久化。 */
  toolCalls?: ChatFunctionToolCall[];
  /** 上游真实终止原因。CPA 在 chunk 里带 native_finish_reason，比标准 finish_reason 信息量大。 */
  nativeFinishReason?: string;
};

export type ChatStreamResult = ChatStreamSnapshot;

/** 前端支持的聊天协议方言。 */
export type ChatProtocol = "chat-completions" | "responses";

export type ChatRequestOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatRequestMessage[];
  reasoningEffort: ReasoningEffort;
  webSearch: boolean;
  /** 仅 Responses 协议支持，chat/completions 下静默忽略。 */
  promptCacheKey?: string;
  onUpdate?: (snapshot: ChatStreamSnapshot) => void;
  signal?: AbortSignal;
};

export type ImageResult = {
  url: string;
  revisedPrompt?: string;
};

export type VideoStatus = {
  status: "pending" | "done" | "failed";
  model?: string;
  progress: number;
  video?: { url: string; duration?: number };
  error?: { code?: string; message: string };
};
