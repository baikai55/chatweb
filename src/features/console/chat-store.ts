import { STORE_SESSIONS, idbDelete, idbGetByScope, idbPut } from "@/shared/db/idb";
import type { ChatMessage, ChatToolActivity, ReasoningEffort } from "@/transport/types";

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
const MAX_SESSIONS_PER_SCOPE = 500;

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
  const text = first?.content.trim().replaceAll(/\s+/g, " ") ?? "";
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 按更新时间倒序。空会话（一条消息都没有）不返回，避免历史里全是空壳。 */
export async function loadSessions(scope: string): Promise<ChatSession[]> {
  try {
    const rows = await idbGetByScope<ChatSession>(STORE_SESSIONS, "byScope", scope);
    return rows
      .filter((session) => session.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    // 隐私模式或数据库打不开。降级成"没有历史"，不影响正常聊天。
    return [];
  }
}

export async function saveSession(session: ChatSession): Promise<void> {
  // 一条消息都没有就别落盘了
  if (session.messages.length === 0) return;
  try {
    await idbPut(STORE_SESSIONS, session);
  } catch {
    // 写失败不该打断对话，内存里的内容仍然可用
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await idbDelete(STORE_SESSIONS, id);
  } catch {
    // 忽略
  }
}

/** 超出上限时清理最旧的。在保存后异步调用即可，不用等它。 */
export async function pruneSessions(scope: string): Promise<void> {
  try {
    const rows = await idbGetByScope<ChatSession>(STORE_SESSIONS, "byScope", scope);
    if (rows.length <= MAX_SESSIONS_PER_SCOPE) return;
    const excess = rows
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, rows.length - MAX_SESSIONS_PER_SCOPE);
    await Promise.all(excess.map((session) => idbDelete(STORE_SESSIONS, session.id)));
  } catch {
    // 忽略
  }
}

export function upsertSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return [session, ...sessions];
  return sessions.map((item, i) => (i === index ? session : item));
}
