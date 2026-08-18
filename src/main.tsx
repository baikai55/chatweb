import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppProviders } from "@/app/providers";
import { App } from "@/app/app";
import "@/shared/i18n";
import "@/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);

// 生产部署时注册 Service Worker，让浏览器提供“添加到主屏幕”安装能力。
// 注册失败不应影响聊天页面本身加载。
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const baseURL = import.meta.env.BASE_URL;
    const swURL = new URL(`${baseURL.endsWith("/") ? baseURL : `${baseURL}/`}sw.js`, window.location.origin);
    navigator.serviceWorker.register(swURL, { scope: baseURL }).catch((error: unknown) => {
      console.warn("Service Worker 注册失败", error);
    });
  });
}
