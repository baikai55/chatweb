import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearScopeSessions,
  createChatPersistenceFailure,
  createBlankSession,
  deleteSession,
  deriveSessionTitle,
  loadSessions,
  MAX_SESSIONS_PER_SCOPE,
  pruneSessions,
  saveSession,
  upsertSession,
  type ChatPersistenceOperation,
  type ChatPersistenceResult,
  type ChatSession,
} from "@/features/console/chat-store";

/**
 * 合并 IndexedDB 快照与加载期间发生的内存修改。
 *
 * 同 id 时内存版本优先；`mutatedIds` 还充当删除墓碑，避免加载开始后删掉的会话
 * 被旧快照重新灌回来。
 */
export function mergeChatSessions(
  current: ChatSession[],
  loaded: ChatSession[],
  mutatedIds: ReadonlySet<string> = new Set(),
): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const session of current) {
    if (session.messages.length > 0) byId.set(session.id, session);
  }
  for (const session of loaded) {
    if (
      session.messages.length > 0
      && !mutatedIds.has(session.id)
      && !byId.has(session.id)
    ) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS_PER_SCOPE);
}

/**
 * 会话列表 + 当前会话。
 *
 * 提到 hook 里是因为侧栏的历史列表和聊天面板要读同一份数据 ——
 * 侧栏点一条历史要能切到聊天面板，聊天面板发完消息侧栏标题要跟着更新。
 *
 * IndexedDB 是异步的，所以初始状态是"空列表 + 一个新建的空会话"，
 * 读完再填。这样首屏不会卡在 loading 上，用户可以直接开始打字。
 *
 * `reloadToken` 变了就重新读一遍 —— 设置页「删除全部记录」之后，
 * 这个 hook 挂在 Console 上不会卸载，得有人告诉它库里已经空了。
 * （三个生成面板的历史不用管：设置页打开时它们本来就被卸载了，回来自然重读。）
 */
export function useChatSessions(scope: string, defaultModel: string, reloadToken = 0) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [current, setCurrent] = useState<ChatSession>(() => createBlankSession(scope, defaultModel));
  const [loading, setLoading] = useState(true);
  const [persistenceError, setPersistenceError] = useState<
    Exclude<ChatPersistenceResult, { ok: true }> | null
  >(null);
  const loadEpochRef = useRef(0);
  const persistenceAttemptRef = useRef(0);
  const mutatedSessionIdsRef = useRef(new Set<string>());

  // defaultModel 变化不该重载会话，用 ref 取最新值
  const defaultModelRef = useRef(defaultModel);
  defaultModelRef.current = defaultModel;

  useEffect(() => {
    let cancelled = false;
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    const persistenceAttempt = persistenceAttemptRef.current + 1;
    persistenceAttemptRef.current = persistenceAttempt;
    mutatedSessionIdsRef.current = new Set();
    setLoading(true);
    setPersistenceError(null);
    setSessions([]);
    setCurrent(createBlankSession(scope, defaultModelRef.current));

    void loadSessions(scope).then((loaded) => {
      if (cancelled || loadEpochRef.current !== loadEpoch) return;
      // IndexedDB 读取期间允许直接开始聊天。这里必须合并，不能让旧快照覆盖
      // 已经 commit 的新会话或新版消息。
      setSessions((currentSessions) => mergeChatSessions(
        currentSessions.filter((session) => session.scope === scope),
        loaded,
        mutatedSessionIdsRef.current,
      ));
      setLoading(false);
    }).catch((caught: unknown) => {
      if (cancelled || loadEpochRef.current !== loadEpoch) return;
      // 读取失败仍降级为空历史并允许聊天，但错误对调用方可见。
      if (persistenceAttemptRef.current === persistenceAttempt) {
        setPersistenceError(createChatPersistenceFailure("load", caught));
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [scope, reloadToken]);

  const trackPersistence = useCallback((
    promise: Promise<ChatPersistenceResult>,
    fallbackOperation: ChatPersistenceOperation,
  ): Promise<ChatPersistenceResult> => {
    const attempt = persistenceAttemptRef.current + 1;
    persistenceAttemptRef.current = attempt;
    const observed = promise.catch((caught: unknown) =>
      createChatPersistenceFailure(fallbackOperation, caught));
    void observed.then((result) => {
      if (persistenceAttemptRef.current !== attempt) return;
      setPersistenceError(result.ok ? null : result);
    });
    return observed;
  }, []);

  /** 写入当前会话并落盘。标题为空时用第一条用户消息生成。 */
  const commit = useCallback((session: ChatSession) => {
    const derivedTitle = session.title || deriveSessionTitle(session.messages);
    const titled = derivedTitle
      ? { ...session, title: derivedTitle }
      : session;
    mutatedSessionIdsRef.current.add(titled.id);
    setCurrent(titled);
    setSessions((previous) => upsertSession(previous, titled).filter((item) => item.messages.length > 0));

    // 逐条删消息删到一条不剩时，库里那条也得删掉 —— `saveSession` 对空会话是
    // 直接 return（本来是为了不给空壳落盘），光靠它的话旧记录还躺在 IndexedDB 里，
    // 一刷新整段对话就复活了。
    if (titled.messages.length === 0) {
      return trackPersistence(deleteSession(titled.id), "delete");
    }
    const persisted = saveSession(titled).then((result) =>
      result.ok ? pruneSessions(scope) : result);
    return trackPersistence(persisted, "save");
  }, [scope, trackPersistence]);

  const startNew = useCallback((model: string) => {
    setCurrent(createBlankSession(scope, model));
  }, [scope]);

  const open = useCallback((id: string) => {
    setSessions((previous) => {
      const target = previous.find((session) => session.id === id);
      if (target) setCurrent(target);
      return previous;
    });
  }, []);

  const remove = useCallback((id: string) => {
    mutatedSessionIdsRef.current.add(id);
    setSessions((previous) => previous.filter((session) => session.id !== id));
    // 删掉的正好是当前会话，就开一个新的顶上
    setCurrent((currentSession) =>
      currentSession.id === id ? createBlankSession(scope, currentSession.model) : currentSession,
    );
    return trackPersistence(deleteSession(id), "delete");
  }, [scope, trackPersistence]);

  const clearAll = useCallback(() => {
    // 让清空前启动、尚未返回的 loadSessions 失效，避免旧快照复活。
    loadEpochRef.current += 1;
    setSessions([]);
    setLoading(false);
    setCurrent(createBlankSession(scope, defaultModelRef.current));
    return trackPersistence(clearScopeSessions(scope), "clear");
  }, [scope, trackPersistence]);

  const clearPersistenceError = useCallback(() => setPersistenceError(null), []);

  return {
    sessions,
    current,
    loading,
    persistenceError,
    clearPersistenceError,
    commit,
    startNew,
    open,
    remove,
    clearAll,
  };
}
