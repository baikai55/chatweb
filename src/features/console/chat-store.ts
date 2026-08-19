import { STORE_SESSIONS, idbClear, idbDelete, idbGetByScope, idbPut } from "@/shared/db/idb";
import {
  readChatContentText,
  type ChatMessage,
  type ChatToolActivity,
  type ReasoningEffort,
} from "@/transport/types";

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
  const rows = await idbGetByScope<ChatSession>(STORE_SESSIONS, "byScope", scope);
  return rows
    .filter((session) => session.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveSession(session: ChatSession): Promise<ChatPersistenceResult> {
  // 一条消息都没有就别落盘了
  if (session.messages.length === 0) return { ok: true };
  try {
    await idbPut(STORE_SESSIONS, session);
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
