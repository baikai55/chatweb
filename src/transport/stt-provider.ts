import type { Backend } from "@/backends/types";
import { resolveVoiceConnection } from "@/transport/voice-routing";

export const STT_PROTOCOLS = ["grok-stt", "openai-transcriptions"] as const;
export type STTProtocol = (typeof STT_PROTOCOLS)[number];

export type STTConnection = {
  protocol: STTProtocol;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 请求凭据来自当前聊天后端，还是独立的语音转写供应商。 */
  source: "backend" | "independent";
  /** Key 允许为空，以兼容不鉴权的本地 OpenAI-compatible 服务。 */
  ready: boolean;
};

/**
 * 旧 UI 的兼容入口。新代码应把完整后端列表交给 `resolveVoiceConnection`，
 * 才能解析 voiceRouting 里对其它 Backend 的引用。
 */
export function resolveSTTConnection(backend: Backend): STTConnection {
  const connection = resolveVoiceConnection(backend, [backend], "stt");
  return {
    protocol: connection.protocol === "openai-audio" ? "openai-transcriptions" : "grok-stt",
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    model: connection.model,
    source: connection.targetBackendId === backend.id ? "backend" : "independent",
    ready: connection.ready,
  };
}
