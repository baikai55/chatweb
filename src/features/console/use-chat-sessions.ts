import { useCallback, useEffect, useRef, useState } from "react";

import {
  createBlankSession,
  deleteSession,
  deriveSessionTitle,
  loadSessions,
  pruneSessions,
  saveSession,
  upsertSession,
  type ChatSession,
} from "@/features/console/chat-store";

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

  // defaultModel 变化不该重载会话，用 ref 取最新值
  const defaultModelRef = useRef(defaultModel);
  defaultModelRef.current = defaultModel;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSessions([]);
    setCurrent(createBlankSession(scope, defaultModelRef.current));

    void loadSessions(scope).then((loaded) => {
      if (cancelled) return;
      setSessions(loaded);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [scope, reloadToken]);

  /** 写入当前会话并落盘。标题为空时用第一条用户消息生成。 */
  const commit = useCallback((session: ChatSession) => {
    const titled = session.title || deriveSessionTitle(session.messages)
      ? { ...session, title: session.title || deriveSessionTitle(session.messages) }
      : session;
    setCurrent(titled);
    setSessions((previous) => upsertSession(previous, titled).filter((item) => item.messages.length > 0));

    // 逐条删消息删到一条不剩时，库里那条也得删掉 —— `saveSession` 对空会话是
    // 直接 return（本来是为了不给空壳落盘），光靠它的话旧记录还躺在 IndexedDB 里，
    // 一刷新整段对话就复活了。
    if (titled.messages.length === 0) {
      void deleteSession(titled.id);
      return;
    }
    void saveSession(titled).then(() => pruneSessions(scope));
  }, [scope]);

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
    setSessions((previous) => previous.filter((session) => session.id !== id));
    // 删掉的正好是当前会话，就开一个新的顶上
    setCurrent((currentSession) =>
      currentSession.id === id ? createBlankSession(scope, currentSession.model) : currentSession,
    );
    void deleteSession(id);
  }, [scope]);

  return { sessions, current, loading, commit, startNew, open, remove };
}
