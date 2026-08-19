/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogModel } from "@/backends/model-catalog";
import { createBackend } from "@/backends/types";
import type { GenerationRecord } from "@/features/history/generation-store";
import { VideoPanel } from "@/features/video/video-panel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record: GenerationRecord = {
  id: "history-video",
  scope: "backend",
  kind: "video",
  createdAt: 1,
  model: "video-model",
  title: "old video",
  assets: [{ url: "https://example.test/old.mp4" }],
};

const videoMocks = vi.hoisted(() => ({
  createVideoGeneration: vi.fn(),
  signal: undefined as AbortSignal | undefined,
}));

const historyMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  record: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/transport/videos", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport/videos")>(),
  createVideoGeneration: videoMocks.createVideoGeneration,
}));

vi.mock("@/features/history/use-generation-history", () => ({
  useGenerationHistory: () => ({
    records: [record],
    clear: historyMocks.clear,
    record: historyMocks.record,
    remove: historyMocks.remove,
  }),
}));

vi.mock("@/features/history/generation-history", () => ({
  GenerationHistory: ({ busy, onDelete, onOpen }: {
    busy?: boolean;
    onDelete: (id: string) => void;
    onOpen: (item: GenerationRecord) => void;
  }) => (
    <div aria-busy={busy || undefined}>
      <button type="button" aria-label="打开历史" disabled={busy} onClick={() => onOpen(record)}>打开历史</button>
      <button type="button" aria-label="删除历史" disabled={busy} onClick={() => onDelete(record.id)}>删除历史</button>
    </div>
  ),
}));

vi.mock("@/features/console/model-picker", () => ({
  ModelPicker: () => null,
}));

vi.mock("@/components/ui/select", () => ({
  Select: TestContainer,
  SelectContent: TestContainer,
  SelectItem: TestContainer,
  SelectTrigger: TestContainer,
  SelectValue: () => null,
}));

function TestContainer({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

const backend = createBackend({ id: "backend", name: "测试", baseURL: "https://example.test/v1" });
const model: CatalogModel = {
  id: "video-model",
  ownedBy: "test",
  kind: "video",
  overridden: false,
  reasoning: false,
  vendor: "unknown",
  saved: true,
};
const roots: Root[] = [];

beforeEach(() => {
  historyMocks.clear.mockReset();
  historyMocks.record.mockReset();
  historyMocks.remove.mockReset();
  videoMocks.createVideoGeneration.mockReset();
  videoMocks.signal = undefined;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("VideoPanel 任务保护", () => {
  it("提交后禁用历史打开和删除，不会因历史操作中止当前请求", async () => {
    videoMocks.createVideoGeneration.mockImplementationOnce(({ signal }) => {
      videoMocks.signal = signal;
      return new Promise(() => {});
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<VideoPanel backend={backend} models={[model]} onManage={vi.fn()} />);
    });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    await act(async () => {
      if (textarea) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "new video");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="生成视频"]')?.click();
    });

    const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="打开历史"]');
    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除历史"]');
    expect(openButton?.disabled).toBe(true);
    expect(deleteButton?.disabled).toBe(true);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      openButton?.click();
      deleteButton?.click();
    });
    expect(videoMocks.signal?.aborted).toBe(false);
    expect(historyMocks.remove).not.toHaveBeenCalled();
  });
});
