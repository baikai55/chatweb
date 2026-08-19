import { STORE_SESSIONS, idbClear, idbDelete, idbGetByScope, idbUpdate } from "@/shared/db/idb";
import {
  readChatContentText,
  type ChatMessage,
  type ChatToolActivity,
  type ReasoningEffort,
} from "@/transport/types";
import { isRecord } from "@/transport/errors";

/**
 * 聊天会话存储。
 *
 * 存 IndexedDB 而不是 localStorage —— 后者只有 5MB，长对话加上推理过程很快撑爆，
 * 撑爆后只能丢最旧的会话。IndexedDB 通常几百 MB 起步，实际上不用考虑上限。
 *
 * 每条会话是一条独立记录（而不是把整个数组序列化成一个键），
 * 所以改一条会话只写一条，不用重写全部。
 *
 * scope = 后端 id，换后端时会话不会串。
 */

export type ConversationMessage = ChatMessage & {
  id: string;
  reasoning?: string;
  tools?: ChatToolActivity[];
  /** 上游真实终止原因，断流时用来显示为什么断了 */
  nativeFinishReason?: string;
};

export type ChatSession = {
  id: string;
  /** 所属后端 id。复合索引 [scope, updatedAt] 的第一段。 */
  scope: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  webSearch: boolean;
  messages: ConversationMessage[];
};

/** 纯粹的失控保护，正常用不到。 */
export const MAX_SESSIONS_PER_SCOPE = 500;

export type ChatPersistenceOperation = "load" | "save" | "delete" | "clear" | "prune";

export type ChatPersistenceFailure = {
  ok: false;
  operation: ChatPersistenceOperation;
  error: Error;
};

export type ChatPersistenceResult = { ok: true } | ChatPersistenceFailure;

export function createChatPersistenceFailure(
  operation: ChatPersistenceOperation,
  caught: unknown,
): ChatPersistenceFailure {
  return {
    ok: false,
    operation,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

export function createMessageId(): string {
  return `m_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createBlankSession(scope: string, model: string): ChatSession {
  const now = Date.now();
  return {
    id: `s_${Math.random().toString(36).slice(2, 10)}${now.toString(36)}`,
    scope,
    title: "",
    createdAt: now,
    updatedAt: now,
    model,
    reasoningEffort: "auto",
    webSearch: false,
    messages: [],
  };
}

const CHAT_ROLES = new Set(["system", "user", "assistant"]);
const REASONING_EFFORTS = new Set(["auto", "none", "low", "medium", "high", "xhigh"]);
const TOOL_STATUSES = new Set(["in_progress", "completed", "failed"]);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isChatContentPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type !== "image_url" || !isRecord(value.image_url)) return false;
  return typeof value.image_url.url === "string"
    && (value.image_url.detail === undefined
      || value.image_url.detail === "auto"
      || value.image_url.detail === "low"
      || value.image_url.detail === "high");
}

function isToolActivity(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.type === "string"
    && typeof value.name === "string"
    && typeof value.status === "string"
    && TOOL_STATUSES.has(value.status)
    && typeof value.detail === "string";
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!isRecord(value)) return false;
  const validContent = typeof value.content === "string"
    || (Array.isArray(value.content) && value.content.every(isChatContentPart));
  return typeof value.id === "string"
    && typeof value.role === "string"
    && CHAT_ROLES.has(value.role)
    && validContent
    && isOptionalString(value.reasoning)
    && isOptionalString(value.nativeFinishReason)
    && (value.tools === undefined
      || (Array.isArray(value.tools) && value.tools.every(isToolActivity)));
}

/** IndexedDB 可能残留旧版本或手工写入的数据，读取时不能只依赖 TypeScript 类型。 */
function isChatSession(value: unknown): value is ChatSession {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.scope === "string"
    && typeof value.title === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === "number"
    && Number.isFinite(value.updatedAt)
    && typeof value.model === "string"
    && typeof value.reasoningEffort === "string"
    && REASONING_EFFORTS.has(value.reasoningEffort)
    && typeof value.webSearch === "boolean"
    && Array.isArray(value.messages)
    && value.messages.every(isConversationMessage);
}

/** 用第一条用户消息做标题。 */
export function deriveSessionTitle(messages: ConversationMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  const text = readChatContentText(first?.content).trim().replaceAll(/\s+/g, " ");
  if (!text) {
    const imageCount = Array.isArray(first?.content)
      ? first.content.filter((part) => part.type === "image_url").length
      : 0;
    if (imageCount > 0) return imageCount === 1 ? "图片" : "图片 × " + imageCount;
    return "";
  }
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

/** 按更新时间倒序。空会话（一条消息都没有）不返回，避免历史里全是空壳。 */
export async function loadSessions(scope: string): Promise<ChatSession[]> {
  const rows = await idbGetByScope<unknown>(STORE_SESSIONS, "byScope", scope);
  return rows
    .filter(isChatSession)
    .filter((session) => session.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 合并其它标签页已经写入的消息，同时应用当前标签页明确执行的删除。
 * shell 设置以本次提交为准；消息按已有顺序保留，本次新增消息追加在末尾。
 */
export function mergePersistedSession(
  stored: unknown,
  incoming: ChatSession,
  removedMessageIds: ReadonlySet<string> = new Set(),
): ChatSession {
  if (!isChatSession(stored) || stored.id !== incoming.id || stored.scope !== incoming.scope) return incoming;

  const incomingById = new Map(incoming.messages.map((message) => [message.id, message]));
  const messages: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const message of stored.messages) {
    if (removedMessageIds.has(message.id)) continue;
    messages.push(incomingById.get(message.id) ?? message);
    seen.add(message.id);
  }
  for (const message of incoming.messages) {
    if (removedMessageIds.has(message.id) || seen.has(message.id)) continue;
    messages.push(message);
  }
  return { ...incoming, messages };
}

export async function saveSession(
  session: ChatSession,
  removedMessageIds: ReadonlySet<string> = new Set(),
): Promise<ChatPersistenceResult> {
  // 一条消息都没有就别落盘了
  if (session.messages.length === 0) return { ok: true };
  try {
    await idbUpdate<unknown>(STORE_SESSIONS, session.id, (stored) =>
      mergePersistedSession(stored, session, removedMessageIds));
    return { ok: true };
  } catch (caught) {
    // 不抛异常打断对话，但必须让 hook / 调用方知道这条记录没有落盘。
    return createChatPersistenceFailure("save", caught);
  }
}

export async function deleteSession(id: string): Promise<ChatPersistenceResult> {
  try {
    await idbDelete(STORE_SESSIONS, id);
    return { ok: true };
  } catch (caught) {
    return createChatPersistenceFailure("delete", caught);
  }
}

/** 清掉全部会话，不分后端。设置页的「删除全部记录」用。 */
export async function clearAllSessions(): Promise<void> {
  await idbClear(STORE_SESSIONS);
}

/** 只清掉一个后端的会话。侧栏标题旁的「清空」用。 */
export async function clearScopeSessions(scope: string): Promise<ChatPersistenceResult> {
  try {
    const rows = await idbGetByScope<ChatSession>(STORE_SESSIONS, "byScope", scope);
    await Promise.all(rows.map((session) => idbDelete(STORE_SESSIONS, session.id)));
    return { ok: true };
  } catch (caught) {
    return createChatPersistenceFailure("clear", caught);
  }
}

/** 超出上限时清理最旧的。在保存后异步调用即可，不用等它。 */
export async function pruneSessions(scope: string): Promise<ChatPersistenceResult> {
  try {
    const rows = await idbGetByScope<ChatSession>(STORE_SESSIONS, "byScope", scope);
    if (rows.length <= MAX_SESSIONS_PER_SCOPE) return { ok: true };
    const excess = rows
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, rows.length - MAX_SESSIONS_PER_SCOPE);
    await Promise.all(excess.map((session) => idbDelete(STORE_SESSIONS, session.id)));
    return { ok: true };
  } catch (caught) {
    return createChatPersistenceFailure("prune", caught);
  }
}

export function upsertSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return [session, ...sessions];
  return sessions.map((item, i) => (i === index ? session : item));
}

/**
 * 请求完成时只用请求结果替换消息，保留流式期间修改过的会话偏好。
 * latest 指向别的会话时退回请求起点，避免把两个会话拼在一起。
 */
export function mergeSessionMessages(
  base: ChatSession,
  latest: ChatSession,
  messages: ConversationMessage[],
  updatedAt = Date.now(),
): ChatSession {
  const shell = latest.id === base.id ? latest : base;
  return { ...shell, messages, updatedAt };
}
