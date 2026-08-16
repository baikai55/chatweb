import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 后端一律跨域直连（CPA 和 grok2api 的 CORS 都全开），所以这里不配 /v1 代理。
    // 只把 /__api 转给本地 wrangler，方便开发时联调上传和反代。
    proxy: {
      "/__api": {
        target: process.env.VITE_WORKER_TARGET ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
