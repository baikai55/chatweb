/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchSettingsSection } from "@/features/settings/settings-view";
import { clearWorkerAccessToken, hasWorkerAccessToken } from "@/transport/worker-access";

afterEach(() => {
  clearWorkerAccessToken();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Worker 认证设置", () => {
  it("设置组件卸载时取消认证且不会落下延迟返回的 token", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    let resolveFetch!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    }));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<SearchSettingsSection />); });
    const password = container.querySelector<HTMLInputElement>('[aria-label="Worker 访问口令"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(password, "password");
      password?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = password?.closest("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(requestSignal?.aborted).toBe(false);
    await act(async () => { root.unmount(); });
    expect(requestSignal?.aborted).toBe(true);

    resolveFetch(Response.json({ token: `${Math.floor(Date.now() / 1000) + 3600}.late-token` }));
    await act(async () => { await Promise.resolve(); });

    expect(hasWorkerAccessToken()).toBe(false);
    expect(storage.length).toBe(0);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
