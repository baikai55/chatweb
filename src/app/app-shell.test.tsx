/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/app/app-shell";
import { backendSchema } from "@/backends/types";

const backend = backendSchema.parse({
  id: "test",
  name: "测试后端",
  baseURL: "https://example.com/v1",
  capabilities: ["chat"],
});

const roots: Root[] = [];

function mockViewport(mobile: boolean): void {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((media: string) => ({
    matches: mobile,
    media,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

async function renderShell(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <AppShell
        backend={backend}
        backends={[backend]}
        mode="chat"
        onModeChange={vi.fn()}
        onBackendChange={vi.fn()}
        settingsOpen={false}
        onToggleSettings={vi.fn()}
        sessions={[]}
        currentSessionId=""
        onOpenSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onClearSessions={vi.fn()}
        onNewChat={vi.fn()}
      >
        <button type="button">主内容按钮</button>
      </AppShell>,
    );
  });
  return container;
}

beforeEach(() => mockViewport(true));

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("AppShell 移动侧栏", () => {
  it("关闭时移出 Tab 顺序，打开后聚焦关闭按钮", async () => {
    const container = await renderShell();
    const sidebar = container.querySelector("aside");
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="打开侧栏"]');

    expect(sidebar?.hasAttribute("inert")).toBe(true);

    await act(async () => trigger?.click());

    expect(sidebar?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭侧栏");
  });

  it("Escape 关闭侧栏并把焦点归还给打开按钮", async () => {
    const container = await renderShell();
    const sidebar = container.querySelector("aside");
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="打开侧栏"]');

    await act(async () => trigger?.click());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("桌面侧栏不会被设为 inert", async () => {
    mockViewport(false);
    const container = await renderShell();

    expect(container.querySelector("aside")?.hasAttribute("inert")).toBe(false);
  });
});
