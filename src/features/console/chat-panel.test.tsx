/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import type { CatalogModel } from "@/backends/model-catalog";
import { ChatPanel } from "@/features/console/chat-panel";
import type { ChatSession } from "@/features/console/chat-store";
import type { ImageInputFile } from "@/shared/image-input";
import type { ChatStreamSnapshot } from "@/transport/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const imageMocks = vi.hoisted(() => ({
  readImageInputFile: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  onUpdate: undefined as ((snapshot: ChatStreamSnapshot) => void) | undefined,
  streamChatCompletions: vi.fn(),
}));

const speechMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
}));

vi.mock("@/shared/image-input", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/image-input")>(),
  readImageInputFile: imageMocks.readImageInputFile,
}));

vi.mock("@/transport/chat-completions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport/chat-completions")>(),
  streamChatCompletions: chatMocks.streamChatCompletions,
}));

vi.mock("@/components/ui/message-scroller", () => ({
  MessageScrollerProvider: ({ children }: { children: ReactNode }) => children,
  MessageScroller: TestContainer,
  MessageScrollerViewport: TestContainer,
  MessageScrollerContent: TestContainer,
  MessageScrollerItem: TestContainer,
  MessageScrollerButton: () => null,
}));

vi.mock("@/components/ui/select", () => ({
  Select: TestContainer,
  SelectContent: TestContainer,
  SelectItem: TestContainer,
  SelectTrigger: TestContainer,
  SelectValue: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: TestContainer,
  TooltipContent: TestContainer,
  TooltipTrigger: TestContainer,
}));

vi.mock("@/features/console/model-picker", () => ({
  ModelPicker: () => null,
}));

vi.mock("@/features/voice/use-chat-reply-speech", () => ({
  useChatReplySpeech: () => ({
    enabled: false,
    phase: "idle",
    toggle: () => ({ ok: true, reason: "" }),
    prepare: speechMocks.prepare,
    speak: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/features/voice/use-voice-call", () => ({
  useVoiceCall: () => ({
    state: {
      open: false,
      phase: "preparing",
      elapsedMs: 0,
      muted: false,
      soundEnabled: true,
      latestUserText: "",
      latestAssistantText: "",
      error: "",
    },
    start: () => ({ ok: false, reason: "" }),
    end: vi.fn(),
    toggleMute: vi.fn(),
    toggleSound: vi.fn(),
    interrupt: vi.fn(),
    retry: vi.fn(),
    finishSpeaking: vi.fn(),
  }),
}));

vi.mock("@/features/voice/voice-call-overlay", () => ({
  VoiceCallOverlay: () => null,
  VoiceCallMiniWindow: () => null,
}));

function TestContainer({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const backend = createBackend({ id: "backend", name: "测试", baseURL: "https://example.test/v1" });
const model: CatalogModel = {
  id: "model",
  ownedBy: "test",
  kind: "chat",
  overridden: false,
  reasoning: false,
  vendor: "unknown",
  saved: true,
};
const roots: Root[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

function session(id: string): ChatSession {
  return {
    id,
    scope: backend.id,
    title: "",
    createdAt: 1,
    updatedAt: 1,
    model: model.id,
    reasoningEffort: "auto",
    webSearch: false,
    messages: [],
  };
}

function panel(current: ChatSession, onCommit = vi.fn()) {
  return (
    <ChatPanel
      backend={backend}
      backends={[backend]}
      models={[model]}
      session={current}
      onCommit={onCommit}
      onManage={vi.fn()}
    />
  );
}

beforeEach(() => {
  imageMocks.readImageInputFile.mockReset();
  chatMocks.onUpdate = undefined;
  chatMocks.streamChatCompletions.mockReset();
  speechMocks.prepare.mockReset();
  frames.clear();
  nextFrameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function submitText(container: HTMLElement, value: string): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  await act(async () => {
    if (textarea) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.click();
  });
}

describe("ChatPanel 图片草稿", () => {
  it("切走再切回原会话时不会接收旧读取批次的图片", async () => {
    const reading = deferred<ImageInputFile>();
    imageMocks.readImageInputFile.mockReturnValueOnce(reading.promise);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const first = session("session-a");

    await act(async () => { root.render(panel(first)); });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["image"], "late.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => {
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => { root.render(panel(session("session-b"))); });
    await act(async () => { root.render(panel(first)); });
    await act(async () => {
      reading.resolve({
        id: "late-image",
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
      await reading.promise;
    });

    expect(container.querySelector('img[alt="late.png"]')).toBeNull();
  });
});

describe("ChatPanel 流式刷新", () => {
  it("用户提交时为持久开启的回复朗读重新解锁播放器", async () => {
    chatMocks.streamChatCompletions.mockResolvedValueOnce({ text: "reply", reasoning: "", tools: [] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(panel(session("speech-unlock"))); });

    await submitText(container, "hello");

    expect(speechMocks.prepare).toHaveBeenCalledOnce();
  });

  it("高频快照每帧只刷新一次，主动停止时保存尚未刷新的最后快照", async () => {
    const onCommit = vi.fn();
    chatMocks.streamChatCompletions.mockImplementationOnce(({ onUpdate, signal }) => {
      chatMocks.onUpdate = onUpdate;
      return new Promise<ChatStreamSnapshot>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(panel(session("streaming"), onCommit)); });
    await submitText(container, "hello");

    await act(async () => {
      for (let index = 1; index <= 100; index += 1) {
        chatMocks.onUpdate?.({ text: `chunk-${index}`, reasoning: "", tools: [] });
      }
    });
    expect(frames.size).toBe(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')?.click();
      await Promise.resolve();
    });

    const committed = onCommit.mock.calls.at(-1)?.[0] as ChatSession;
    expect(committed.messages.at(-1)?.content).toBe("chunk-100");
    expect(frames.size).toBe(0);
  });

  it("完成和失败都使用最新结果，并清理尚未执行的刷新帧", async () => {
    const cases = [
      { terminal: "complete" as const, expected: "final-result" },
      { terminal: "fail" as const, expected: "partial-before-error" },
    ];

    for (const testCase of cases) {
      const response = deferred<ChatStreamSnapshot>();
      const onCommit = vi.fn();
      chatMocks.streamChatCompletions.mockImplementationOnce(({ onUpdate }) => {
        chatMocks.onUpdate = onUpdate;
        return response.promise;
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => { root.render(panel(session(`terminal-${testCase.terminal}`), onCommit)); });
      await submitText(container, "hello");
      await act(async () => {
        chatMocks.onUpdate?.({ text: "partial-before-error", reasoning: "", tools: [] });
      });
      expect(frames.size).toBe(1);

      await act(async () => {
        if (testCase.terminal === "complete") {
          response.resolve({ text: "final-result", reasoning: "", tools: [] });
        } else {
          response.reject(new Error("network failed"));
        }
        await response.promise.catch(() => undefined);
      });

      const committed = onCommit.mock.calls.at(-1)?.[0] as ChatSession;
      expect(committed.messages.at(-1)?.content).toBe(testCase.expected);
      expect(frames.size).toBe(0);
      await act(async () => { root.unmount(); });
      roots.splice(roots.indexOf(root), 1);
      container.remove();
    }
  });

  it("切换会话会取消旧请求的待刷新帧，旧快照不会回写新会话", async () => {
    const onCommit = vi.fn();
    chatMocks.streamChatCompletions.mockImplementationOnce(({ onUpdate, signal }) => {
      chatMocks.onUpdate = onUpdate;
      return new Promise<ChatStreamSnapshot>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => { root.render(panel(session("old"), onCommit)); });
    await submitText(container, "hello");
    await act(async () => {
      chatMocks.onUpdate?.({ text: "old-session-chunk", reasoning: "", tools: [] });
    });
    expect(frames.size).toBe(1);

    await act(async () => {
      root.render(panel(session("new"), onCommit));
      await Promise.resolve();
    });

    expect(frames.size).toBe(0);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("old-session-chunk");
  });
});
