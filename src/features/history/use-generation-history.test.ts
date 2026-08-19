/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_GENERATIONS_PER_KIND,
  type GenerationPersistenceFailure,
  type GenerationPersistenceResult,
  type GenerationRecord,
} from "@/features/history/generation-store";
import { mergeGenerationRecords, useGenerationHistory } from "@/features/history/use-generation-history";

const storeMocks = vi.hoisted(() => ({
  deleteGeneration: vi.fn(),
  deleteGenerationsThrough: vi.fn(),
  loadGenerations: vi.fn(),
  pruneGenerations: vi.fn(),
  saveGeneration: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/features/history/generation-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/history/generation-store")>(),
  deleteGeneration: storeMocks.deleteGeneration,
  deleteGenerationsThrough: storeMocks.deleteGenerationsThrough,
  loadGenerations: storeMocks.loadGenerations,
  pruneGenerations: storeMocks.pruneGenerations,
  saveGeneration: storeMocks.saveGeneration,
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

function record(id: string, createdAt: number, title = id): GenerationRecord {
  return {
    id,
    scope: "backend",
    kind: "voice",
    createdAt,
    model: "voice-model",
    title,
    assets: [],
  };
}

type HookValue = ReturnType<typeof useGenerationHistory>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const roots: Root[] = [];

async function renderHook(): Promise<{ get: () => HookValue }> {
  let value: HookValue | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  function Harness() {
    value = useGenerationHistory("backend", "voice");
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
  storeMocks.deleteGeneration.mockReset().mockResolvedValue({ ok: true });
  storeMocks.deleteGenerationsThrough.mockReset().mockResolvedValue({ ok: true });
  storeMocks.loadGenerations.mockReset().mockResolvedValue([]);
  storeMocks.pruneGenerations.mockReset().mockResolvedValue({ ok: true });
  storeMocks.saveGeneration.mockReset().mockResolvedValue({ ok: true });
  toastMocks.error.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("mergeGenerationRecords", () => {
  it("保留异步加载期间刚生成的记录", () => {
    const current = record("new", 20);
    const loaded = record("old", 10);

    expect(mergeGenerationRecords([current], [loaded])).toEqual([current, loaded]);
  });

  it("同 id 时以内存中的记录为准", () => {
    const current = record("same", 20, "内存新版");
    // 故意让磁盘记录时间更新，确保实现依据来源优先级，而不是碰巧选时间较新的。
    const loaded = record("same", 30, "磁盘旧版");

    expect(mergeGenerationRecords([current], [loaded])).toEqual([current]);
  });

  it("内存列表只保留最新 50 条", () => {
    const records = Array.from(
      { length: MAX_GENERATIONS_PER_KIND + 5 },
      (_, index) => record(`record-${index}`, index),
    );

    const merged = mergeGenerationRecords([], records);

    expect(merged).toHaveLength(MAX_GENERATIONS_PER_KIND);
    expect(merged[0]?.createdAt).toBe(MAX_GENERATIONS_PER_KIND + 4);
    expect(merged.at(-1)?.createdAt).toBe(5);
  });
});

describe("useGenerationHistory 持久化可靠性", () => {
  it("读取失败不会伪装成空历史", async () => {
    const error = new Error("IndexedDB unavailable");
    storeMocks.loadGenerations.mockRejectedValueOnce(error);
    const hook = await renderHook();

    await act(async () => { await Promise.resolve(); });

    expect(hook.get().loading).toBe(false);
    expect(hook.get().persistenceError).toEqual({ ok: false, operation: "load", error });
    expect(toastMocks.error).toHaveBeenCalledWith("生成历史读取失败，本次仍可继续生成");
  });

  it("保存失败停止裁剪、暴露错误并统一提示用户", async () => {
    const error = new Error("quota exceeded");
    const failure: GenerationPersistenceFailure = { ok: false, operation: "save", error };
    storeMocks.saveGeneration.mockResolvedValueOnce(failure);
    const hook = await renderHook();

    await act(async () => {
      hook.get().record({ model: "voice-model", title: "语音", assets: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hook.get().persistenceError).toBe(failure);
    expect(storeMocks.pruneGenerations).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith("生成结果未能保存，刷新页面后可能丢失");
  });

  it("删除失败同样暴露错误并提示记录可能恢复", async () => {
    const error = new Error("transaction aborted");
    const failure: GenerationPersistenceFailure = { ok: false, operation: "delete", error };
    storeMocks.deleteGeneration.mockResolvedValueOnce(failure);
    const hook = await renderHook();

    await act(async () => { await hook.get().remove("record"); });

    expect(hook.get().persistenceError).toBe(failure);
    expect(toastMocks.error).toHaveBeenCalledWith("删除未能写入浏览器存储，刷新后记录可能恢复");
  });

  it("较旧的失败不会覆盖较新的成功", async () => {
    const older = deferred<GenerationPersistenceResult>();
    const newer = deferred<GenerationPersistenceResult>();
    storeMocks.deleteGeneration
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const hook = await renderHook();

    let olderResult!: Promise<GenerationPersistenceResult>;
    let newerResult!: Promise<GenerationPersistenceResult>;
    await act(async () => {
      olderResult = hook.get().remove("older");
      newerResult = hook.get().remove("newer");
    });

    await act(async () => {
      newer.resolve({ ok: true });
      await newerResult;
    });
    const oldFailure: GenerationPersistenceFailure = {
      ok: false,
      operation: "delete",
      error: new Error("old transaction failed"),
    };
    await act(async () => {
      older.resolve(oldFailure);
      await olderResult;
    });

    expect(hook.get().persistenceError).toBeNull();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
