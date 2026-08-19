import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteGeneration,
  deleteGenerationsThrough,
  loadGenerations,
  pruneGenerations,
  saveGeneration,
  toAsset,
  type GenerationRecord,
} from "@/features/history/generation-store";
import { DEFAULT_MEDIA_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

const idbMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  delete: vi.fn(),
  getByPrefix: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/shared/db/idb", () => ({
  STORE_GENERATIONS: "generations",
  idbClear: idbMocks.clear,
  idbDelete: idbMocks.delete,
  idbGetByPrefix: idbMocks.getByPrefix,
  idbPut: idbMocks.put,
}));

beforeEach(() => {
  idbMocks.clear.mockReset().mockResolvedValue(undefined);
  idbMocks.delete.mockReset().mockResolvedValue(undefined);
  idbMocks.getByPrefix.mockReset().mockResolvedValue([]);
  idbMocks.put.mockReset().mockResolvedValue("generation");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("toAsset 媒体读取", () => {
  it("正文读取超时会中止 fetch 并回退保存原 URL", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "blob").mockImplementation(() => new Promise<Blob>(() => undefined));
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return Promise.resolve(response);
    }));

    const loading = toAsset("blob:history-media", "备注");
    const assertion = expect(loading).resolves.toEqual({ url: "blob:history-media", note: "备注" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_MEDIA_REQUEST_TIMEOUT_MS);

    await assertion;
    expect(requestSignal).toMatchObject({ aborted: true });
  });

  it("外部取消时保留 AbortError，不回退成失效 URL", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    }));

    const loading = toAsset("blob:history-media", undefined, controller.signal);
    controller.abort();

    await expect(loading).rejects.toBe(controller.signal.reason);
    expect(controller.signal.reason).toMatchObject({ name: "AbortError" });
    expect(requestSignal).toMatchObject({ aborted: true });
  });
});

describe("生成历史读取", () => {
  it("过滤损坏记录，同时保留缺少可选字段的旧记录", async () => {
    const older: GenerationRecord = {
      id: "older",
      scope: "backend",
      kind: "image",
      createdAt: 1,
      model: "image-model",
      title: "旧记录",
      assets: [],
    };
    const newer: GenerationRecord = {
      ...older,
      id: "newer",
      createdAt: 2,
      assets: [{ url: "https://example.com/image.png", note: "图片" }],
      params: { prompt: "图片" },
    };
    idbMocks.getByPrefix.mockResolvedValueOnce([
      older,
      { ...older, id: "missing-assets", assets: undefined },
      { ...older, id: "broken-asset", assets: [{ url: 42 }] },
      newer,
    ]);

    await expect(loadGenerations("backend", "image")).resolves.toEqual([newer, older]);
  });
});

describe("生成历史持久化失败", () => {
  const record: GenerationRecord = {
    id: "generation",
    scope: "backend",
    kind: "image",
    createdAt: 1,
    model: "image-model",
    title: "图片",
    assets: [],
  };

  it("保存失败返回带操作类型的可观察结果", async () => {
    const error = new Error("quota exceeded");
    idbMocks.put.mockRejectedValueOnce(error);

    await expect(saveGeneration(record)).resolves.toEqual({
      ok: false,
      operation: "save",
      error,
    });
  });

  it("删除失败返回带操作类型的可观察结果", async () => {
    const error = new Error("transaction aborted");
    idbMocks.delete.mockRejectedValueOnce(error);

    await expect(deleteGeneration(record.id)).resolves.toEqual({
      ok: false,
      operation: "delete",
      error,
    });
  });

  it("按面板清空失败返回 clear 结果", async () => {
    const error = new Error("database blocked");
    idbMocks.getByPrefix.mockRejectedValueOnce(error);

    await expect(deleteGenerationsThrough("backend", "image", Date.now())).resolves.toEqual({
      ok: false,
      operation: "clear",
      error,
    });
  });

  it("按面板清空时坏行不阻断有效记录删除", async () => {
    idbMocks.getByPrefix.mockResolvedValueOnce([
      record,
      { ...record, id: "broken", assets: undefined },
    ]);

    await expect(deleteGenerationsThrough("backend", "image", 1)).resolves.toEqual({ ok: true });
    expect(idbMocks.delete).toHaveBeenCalledOnce();
    expect(idbMocks.delete).toHaveBeenCalledWith("generations", record.id);
  });

  it("裁剪失败返回 prune 结果", async () => {
    const error = new Error("database blocked");
    idbMocks.getByPrefix.mockRejectedValueOnce(error);

    await expect(pruneGenerations("backend", "image")).resolves.toEqual({
      ok: false,
      operation: "prune",
      error,
    });
  });

  it("裁剪时坏行不计入上限，也不阻断有效记录清理", async () => {
    const validRows = Array.from(
      { length: 51 },
      (_, index): GenerationRecord => ({ ...record, id: `generation-${index}`, createdAt: index }),
    );
    idbMocks.getByPrefix.mockResolvedValueOnce([
      ...validRows,
      { ...record, id: "broken", assets: [{ url: 42 }] },
    ]);

    await expect(pruneGenerations("backend", "image")).resolves.toEqual({ ok: true });
    expect(idbMocks.delete).toHaveBeenCalledOnce();
    expect(idbMocks.delete).toHaveBeenCalledWith("generations", "generation-0");
  });
});
