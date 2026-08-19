import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppErrorBoundary } from "@/app/app-error-boundary";
import { AppProviders } from "@/app/providers";
import { App } from "@/app/app";
import "@/shared/i18n";
import "@/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppProviders>
        <App />
      </AppProviders>
    </AppErrorBoundary>
  </StrictMode>,
);

// 生产部署时注册 Service Worker，让浏览器提供“添加到主屏幕”安装能力。
// 注册失败不应影响聊天页面本身加载。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const baseURL = import.meta.env.BASE_URL;
    const swURL = new URL(`${baseURL.endsWith("/") ? baseURL : `${baseURL}/`}sw.js`, window.location.origin);
    // 用当前入口文件的 hash 标识构建版本。Service Worker 的脚本内容不一定随
    // 每次前端构建变化，只有注册 URL 也带上版本，浏览器才会安装新版本并清掉旧缓存。
    const entryScript = Array.from(document.scripts)
      .find((script) => script.type === "module" && script.src);
    const buildId = entryScript
      ? new URL(entryScript.src).pathname.split("/").pop()
      : undefined;
    if (buildId) swURL.searchParams.set("build", buildId);
    const scopeURL = new URL(baseURL, window.location.origin);
    const shellAssets = Array.from(document.querySelectorAll("script[src], link[href]"))
      .map((element) => element.getAttribute("src") ?? element.getAttribute("href") ?? "")
      .filter(Boolean)
      .map((value) => new URL(value, window.location.href))
      .filter((url) => url.origin === scopeURL.origin && url.pathname.startsWith(scopeURL.pathname));
    for (const asset of shellAssets) {
      swURL.searchParams.append("asset", `${asset.pathname}${asset.search}`);
    }
    navigator.serviceWorker.register(swURL, { scope: baseURL }).catch((error: unknown) => {
      console.warn("Service Worker 注册失败", error);
    });
  });
}
