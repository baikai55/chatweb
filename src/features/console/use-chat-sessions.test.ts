/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChatPersistenceFailure,
  type ChatPersistenceResult,
  type ChatSession,
} from "@/features/console/chat-store";
import { useChatSessions } from "@/features/console/use-chat-sessions";

const storeMocks = vi.hoisted(() => ({
  clearScopeSessions: vi.fn(),
  deleteSession: vi.fn(),
  loadSessions: vi.fn(),
  pruneSessions: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock("@/features/console/chat-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/console/chat-store")>(),
  clearScopeSessions: storeMocks.clearScopeSessions,
  deleteSession: storeMocks.deleteSession,
  loadSessions: storeMocks.loadSessions,
  pruneSessions: storeMocks.pruneSessions,
  saveSession: storeMocks.saveSession,
}));

type HookValue = ReturnType<typeof useChatSessions>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(id: string, updatedAt: number, title = id): ChatSession {
  return {
    id,
    scope: "backend",
    title,
    createdAt: 1,
    updatedAt,
    model: "model",
    reasoningEffort: "auto",
    webSearch: false,
    messages: [{ id: `message-${id}`, role: "user", content: title }],
  };
}

const roots: Root[] = [];

async function renderHook(): Promise<{ get: () => HookValue }> {
  let value: HookValue | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  function Harness() {
    value = useChatSessions("backend", "model");
    return null;
  }

  await act(async () => { root.render(createElement(Harness)); });
  return {
    get: () => {
      if (!value) throw new Error("hook 尚未渲染");
      return value;
    },
  };
}

beforeEach(() => {
  storeMocks.clearScopeSessions.mockReset().mockResolvedValue({ ok: true });
  storeMocks.deleteSession.mockReset().mockResolvedValue({ ok: true });
  storeMocks.loadSessions.mockReset().mockResolvedValue([]);
  storeMocks.pruneSessions.mockReset().mockResolvedValue({ ok: true });
  storeMocks.saveSession.mockReset().mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("useChatSessions 可靠性", () => {
  it("保留异步加载期间提交的新会话，并以内存修改版本为准", async () => {
    const loading = deferred<ChatSession[]>();
    storeMocks.loadSessions.mockReturnValueOnce(loading.promise);
    const hook = await renderHook();
    const inMemory = session("same", 30, "内存新版");

    await act(async () => { await hook.get().commit(inMemory); });

    await act(async () => {
      loading.resolve([
        session("old", 10, "磁盘旧会话"),
        session("same", 40, "磁盘旧版本"),
      ]);
      await loading.promise;
    });

    expect(hook.get().sessions.map((item) => [item.id, item.title])).toEqual([
      ["same", "内存新版"],
      ["old", "磁盘旧会话"],
    ]);
    expect(hook.get().loading).toBe(false);
  });

  it("清空会使尚未完成的加载快照失效", async () => {
    const loading = deferred<ChatSession[]>();
    storeMocks.loadSessions.mockReturnValueOnce(loading.promise);
    const hook = await renderHook();

    await act(async () => { await hook.get().clearAll(); });
    await act(async () => {
      loading.resolve([session("old", 10)]);
      await loading.promise;
    });

    expect(hook.get().sessions).toEqual([]);
    expect(hook.get().loading).toBe(false);
  });

  it("保存失败既通过返回值传播，也暴露在 hook 状态中", async () => {
    const error = new Error("quota exceeded");
    const failure: ChatPersistenceFailure = { ok: false, operation: "save", error };
    storeMocks.saveSession.mockResolvedValueOnce(failure);
    const hook = await renderHook();
    let result: ChatPersistenceResult | undefined;

    await act(async () => { result = await hook.get().commit(session("new", 20)); });

    expect(result).toBe(failure);
    expect(hook.get().persistenceError).toBe(failure);
    expect(storeMocks.pruneSessions).not.toHaveBeenCalled();
  });

  it("读取失败时仍结束 loading，并向调用方暴露错误", async () => {
    const loading = deferred<ChatSession[]>();
    storeMocks.loadSessions.mockReturnValueOnce(loading.promise);
    const hook = await renderHook();
    const error = new Error("database blocked");

    await act(async () => {
      loading.reject(error);
      await loading.promise.catch(() => undefined);
    });

    expect(hook.get().loading).toBe(false);
    expect(hook.get().sessions).toEqual([]);
    expect(hook.get().persistenceError).toEqual({ ok: false, operation: "load", error });
  });
});
