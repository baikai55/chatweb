import { joinURL } from "@/transport/chat-completions";
import type { BackendFlavor, Capability } from "@/backends/types";

/**
 * 能力探测。
 *
 * 判定规则：**404 = 路由不存在，其它任何状态 = 路由存在。**
 *
 * 为什么不用 OPTIONS：CPA 的 CORS 中间件在路由之前就 AbortWithStatus(204)，
 * 对任何路径（包括根本不存在的）都返回 204，区分不出来。实测确认过。
 *
 * 为什么发 POST {}：带不带 key 都能用。
 *   无 key  → 存在的路由返 401，不存在的返 404
 *   有 key  → 存在的路由返 400（body 不合法），不存在的仍返 404
 * 两种情况下 404 都唯一地指向"路由不存在"。
 *
 * 已知误报：如果后端有 SPA catch-all（未匹配路径返回 index.html 而非 404），
 * 会把所有能力都探成存在。这种情况下会给出提示，让用户手动勾选。
 */

const PROBE_TARGETS: Array<{ capability: Capability; path: string }> = [
  { capability: "chat", path: "/chat/completions" },
  { capability: "image", path: "/images/generations" },
  { capability: "video", path: "/videos/generations" },
  { capability: "tts", path: "/tts" },
  { capability: "stt", path: "/stt" },
];

export type ProbeResult = {
  capabilities: Capability[];
  flavor: BackendFlavor;
  /** 探测不可信（疑似 catch-all 兜底），应该提示用户手动确认 */
  suspicious: boolean;
  /** 每个端点的原始状态码，用于设置页展示细节 */
  detail: Array<{ capability: Capability; path: string; status: number | null }>;
};

export async function probeBackend(baseURL: string, signal?: AbortSignal): Promise<ProbeResult> {
  const flavor = await detectFlavor(baseURL, signal);

  const detail = await Promise.all(
    PROBE_TARGETS.map(async ({ capability, path }) => ({
      capability,
      path,
      status: await probeStatus(joinURL(baseURL, path), signal),
    })),
  );

  const capabilities = detail
    .filter((item) => item.status !== null && item.status !== 404)
    .map((item) => item.capability);

  // 全部返回 200 基本可以断定是 catch-all —— 正常后端对空 body 不会全部 200
  const allOk = detail.every((item) => item.status === 200);

  return { capabilities, flavor, suspicious: allOk, detail };
}

async function probeStatus(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    return response.status;
  } catch {
    // 网络失败 / CORS 被拦。区分不出来，都当探测失败处理。
    return null;
  }
}

/**
 * 后端方言识别。用响应头，不猜。
 *
 * CPA 把 X-CPA-* 全部放进了 Access-Control-Expose-Headers，所以浏览器读得到。
 * grok2api 只暴露 X-Request-ID。
 */
async function detectFlavor(baseURL: string, signal?: AbortSignal): Promise<BackendFlavor> {
  try {
    const response = await fetch(joinURL(baseURL, "/models"), { method: "GET", signal });
    if (response.headers.get("X-CPA-Version") || response.headers.get("x-cpa-trace-id")) return "cpa";
    // 兜底：有些部署可能不回版本头，看 expose 列表里有没有 X-CPA
    const exposed = response.headers.get("Access-Control-Expose-Headers") ?? "";
    if (exposed.toLowerCase().includes("x-cpa")) return "cpa";
    if (response.headers.get("X-Request-ID")) return "grok2api";
    return "generic";
  } catch {
    return "generic";
  }
}
