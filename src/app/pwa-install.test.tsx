/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallAppButton } from "@/app/pwa-install";

const roots: Root[] = [];

async function renderButton(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<InstallAppButton />));
  return container;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("InstallAppButton", () => {
  it("消费安装提示后重新挂载也不会复用旧事件", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt,
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });

    await act(async () => window.dispatchEvent(event));
    const first = await renderButton();
    const installButton = first.querySelector<HTMLButtonElement>('[aria-label="安装到手机"]');
    expect(installButton).not.toBeNull();

    await act(async () => installButton?.click());
    expect(prompt).toHaveBeenCalledOnce();
    expect(first.querySelector('[aria-label="安装到手机"]')).toBeNull();

    const second = await renderButton();
    expect(second.querySelector('[aria-label="安装到手机"]')).toBeNull();
  });
});
