/**
 * 协议层的统一类型。
 *
 * 不同后端说不同的话（chat/completions、Responses、Anthropic Messages），
 * 但 UI 只认这里定义的这一套。每个适配器负责把上游的方言翻译成 ChatStreamSnapshot。
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

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
  messages: ChatMessage[];
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
