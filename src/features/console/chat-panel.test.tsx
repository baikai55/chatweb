/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import type { CatalogModel } from "@/backends/model-catalog";
import { ChatPanel } from "@/features/console/chat-panel";
import type { ChatSession } from "@/features/console/chat-store";
import type { ImageInputFile } from "@/shared/image-input";

const imageMocks = vi.hoisted(() => ({
  readImageInputFile: vi.fn(),
}));

vi.mock("@/shared/image-input", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/shared/image-input")>(),
  readImageInputFile: imageMocks.readImageInputFile,
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
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
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

function panel(current: ChatSession) {
  return (
    <ChatPanel
      backend={backend}
      backends={[backend]}
      models={[model]}
      session={current}
      onCommit={vi.fn()}
      onManage={vi.fn()}
    />
  );
}

beforeEach(() => {
  imageMocks.readImageInputFile.mockReset();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

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
