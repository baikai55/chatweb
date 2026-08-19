import { describe, expect, it, vi } from "vitest";

import { completeBackendSetup } from "@/app/app";
import { createBackend } from "@/backends/types";

const toastMocks = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMocks }));

describe("首次添加后端", () => {
  it("持久化失败时停留在引导页", () => {
    const backend = createBackend({ name: "测试", baseURL: "https://example.com/v1" });
    const save = vi.fn(() => {
      throw new Error("浏览器未能保存后端配置");
    });
    const close = vi.fn();

    completeBackendSetup(backend, save, close);

    expect(close).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith("浏览器未能保存后端配置");
  });

  it("持久化成功后退出引导页", () => {
    const backend = createBackend({ name: "测试", baseURL: "https://example.com/v1" });
    const close = vi.fn();

    completeBackendSetup(backend, vi.fn(), close);

    expect(close).toHaveBeenCalledOnce();
  });
});
