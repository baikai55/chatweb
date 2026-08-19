/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackend } from "@/backends/types";
import {
  BackendSection,
  CustomTTSRouteSection,
  ImageTimeoutInput,
  RouteSection,
  SearchSettingsSection,
  clearStoredRecords,
} from "@/features/settings/settings-view";
import { BUILTIN_ROUTE_DEFS, draftCustomRoute } from "@/transport/image-routes";
import { clearWorkerAccessToken, hasWorkerAccessToken } from "@/transport/worker-access";

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

afterEach(() => {
  clearWorkerAccessToken();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toastMocks.error.mockReset();
  toastMocks.success.mockReset();
});

describe("跨标签页设置草稿", () => {
  it("搜索表单未编辑时同步外部值，已编辑时阻止静默覆盖", async () => {
    dispatchSettings({ searchApiKey: "initial-key" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<SearchSettingsSection />); });
    const apiKey = container.querySelector<HTMLInputElement>('input[type="password"]:not([aria-label])');
    expect(apiKey?.value).toBe("initial-key");

    await act(async () => { dispatchSettings({ searchApiKey: "remote-clean" }); });
    expect(apiKey?.value).toBe("remote-clean");

    await setInput(apiKey, "local-draft");
    await act(async () => { dispatchSettings({ searchApiKey: "remote-conflict" }); });
    expect(apiKey?.value).toBe("local-draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("其他标签页更新");
    const save = findButton(container, "保存");
    expect(save?.disabled).toBe(true);

    await act(async () => { findButton(container, "载入最新")?.click(); });
    expect(apiKey?.value).toBe("remote-conflict");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("设置写失败时图片超时输入恢复到已保存值", async () => {
    dispatchSettings({ imageTimeoutSeconds: 300 });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<ImageTimeoutInput />); });
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    await setInput(input, "600");
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await act(async () => { input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });

    expect(input?.value).toBe("300");
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining("浏览器未能保存设置"));
    setItem.mockRestore();
    await act(async () => { root.unmount(); });
  });

  it("后端表单保留本地草稿并提示外部更新冲突", async () => {
    const initial = createBackend({ id: "backend", name: "初始", baseURL: "https://initial.example/v1", apiKey: "initial" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onPatch = vi.fn(() => true);
    const render = (backend = initial) => root.render(
      <BackendSection backend={backend} onPatch={onPatch} onRemove={vi.fn()} onAdd={vi.fn()} />,
    );
    await act(async () => { render(); });
    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    const cleanRemote = { ...initial, name: "远端干净更新", apiKey: "clean-key" };
    await act(async () => { render(cleanRemote); });
    expect(inputs[0]?.value).toBe("远端干净更新");
    expect(inputs[2]?.value).toBe("clean-key");

    await setInput(inputs[0], "本地草稿");
    const remote = { ...cleanRemote, name: "远端名称", apiKey: "remote-key" };

    await act(async () => { render(remote); });

    expect(inputs[0]?.value).toBe("本地草稿");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("其他标签页更新");
    expect(findButton(container, "保存")?.disabled).toBe(true);
    expect(onPatch).not.toHaveBeenCalled();

    await act(async () => { findButton(container, "载入最新")?.click(); });
    expect(inputs[0]?.value).toBe("远端名称");
    expect(inputs[2]?.value).toBe("remote-key");
    await act(async () => { root.unmount(); });
  });
});

describe("删除全部记录", () => {
  it("分别报告聊天和生成记录的清理结果", async () => {
    const clearSessions = vi.fn().mockResolvedValue(undefined);
    const clearGenerations = vi.fn().mockRejectedValue(new Error("generation failed"));
    const onSessionsCleared = vi.fn();

    await expect(clearStoredRecords({
      clearSessions,
      clearGenerations,
      onSessionsCleared,
    })).resolves.toEqual({
      sessionsCleared: true,
      generationsCleared: false,
    });
    expect(onSessionsCleared).toHaveBeenCalledOnce();
  });

  it("生成记录仍在清理时就刷新已清除的聊天内存", async () => {
    let finishGenerations!: () => void;
    const clearGenerations = vi.fn(() => new Promise<void>((resolve) => {
      finishGenerations = resolve;
    }));
    const onSessionsCleared = vi.fn();
    const clearing = clearStoredRecords({
      clearSessions: vi.fn().mockResolvedValue(undefined),
      clearGenerations,
      onSessionsCleared,
    });

    await vi.waitFor(() => expect(onSessionsCleared).toHaveBeenCalledOnce());
    let settled = false;
    void clearing.then(() => { settled = true; });
    expect(settled).toBe(false);

    finishGenerations();
    await expect(clearing).resolves.toEqual({ sessionsCleared: true, generationsCleared: true });
  });
});

describe("路由配置写入失败", () => {
  it("图片路由保存或删除失败时保留编辑草稿且不提示成功", async () => {
    const route = draftCustomRoute(BUILTIN_ROUTE_DEFS.chat, "custom-chat");
    const backend = createBackend({
      name: "图片供应商",
      baseURL: "https://image.example.test/v1",
      customImageRoutes: [route],
    });
    const onPatch = vi.fn(() => false);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<RouteSection backend={backend} onPatch={onPatch} />); });

    await act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label="编辑 ${route.name}"]`)?.click(); });
    expect(container.querySelector(`textarea[aria-label="${route.name} 的定义"]`)).not.toBeNull();

    await act(async () => { findButton(container, "保存")?.click(); });
    expect(container.querySelector(`textarea[aria-label="${route.name} 的定义"]`)).not.toBeNull();
    expect(toastMocks.success).not.toHaveBeenCalled();

    await act(async () => { container.querySelector<HTMLButtonElement>(`[aria-label="删除 ${route.name}"]`)?.click(); });
    expect(container.querySelector(`textarea[aria-label="${route.name} 的定义"]`)).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("MiMo 路由模板创建失败时不进入编辑态也不提示成功", async () => {
    const backend = createBackend({
      id: "backend",
      name: "语音供应商",
      baseURL: "https://voice.example.test/v1",
    });
    const onPatchBackend = vi.fn(() => false);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CustomTTSRouteSection owner={backend} backends={[backend]} onPatchBackend={onPatchBackend} />);
    });

    await act(async () => { findButton(container, "新建路由")?.click(); });

    expect(onPatchBackend).toHaveBeenCalledOnce();
    expect(container.querySelector("textarea")).toBeNull();
    expect(toastMocks.success).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});

function dispatchSettings(overrides: Record<string, unknown>): void {
  localStorage.setItem("chatweb:settings", JSON.stringify(overrides));
  window.dispatchEvent(new StorageEvent("storage", {
    key: "chatweb:settings",
    newValue: JSON.stringify(overrides),
  }));
}

async function setInput(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

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
