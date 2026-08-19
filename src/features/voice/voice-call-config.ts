import type { SynthesizeSpeechOptions } from "@/transport/voice";
import type { VoiceConnection } from "@/transport/voice-routing";

export const VOICE_CALL_LANGUAGE = "zh";

export type VoiceCallRequirement = "chat" | "stt" | "tts";

export type VoiceCallConfigIssue = {
  requirement: VoiceCallRequirement;
  message: string;
};

export type VoiceCallConfigInput = {
  chatModel: string;
  sttConnection: VoiceConnection;
  ttsConnection: VoiceConnection;
};

export type VoiceCallConfig = {
  chatModel: string;
  sttConnection: VoiceConnection;
  ttsConnection: VoiceConnection;
  ready: boolean;
  issues: VoiceCallConfigIssue[];
  reason: string;
};

/**
 * 收敛通话启动前检查。连接已经由 voice routing 解析完成，这里不再按后端 id
 * 重新拼接地址和 Key，避免跨后端语音配置发生凭据串用。
 */
export function resolveVoiceCallConfig(input: VoiceCallConfigInput): VoiceCallConfig {
  const chatModel = input.chatModel.trim();
  const issues: VoiceCallConfigIssue[] = [];

  if (!chatModel) {
    issues.push({ requirement: "chat", message: "请先选择聊天模型" });
  }
  const sttIssue = voiceConnectionIssue(input.sttConnection, "语音转写");
  if (sttIssue) issues.push({ requirement: "stt", message: sttIssue });
  const ttsIssue = voiceConnectionIssue(input.ttsConnection, "语音合成");
  if (ttsIssue) issues.push({ requirement: "tts", message: ttsIssue });

  return {
    chatModel,
    sttConnection: input.sttConnection,
    ttsConnection: input.ttsConnection,
    ready: issues.length === 0,
    issues,
    reason: issues.map((issue) => issue.message).join("；"),
  };
}

export function defaultVoiceCallVoice(connection: VoiceConnection): string {
  const routeDefault = connection.ttsRoute?.defaultVoice.trim();
  if (routeDefault) return routeDefault;
  return connection.protocol === "openai-audio" ? "alloy" : "eve";
}

/** 构造一次通话回复的 TTS 参数，所有请求路由和凭据都来自同一个连接。 */
export function buildVoiceCallTTSOptions(
  connection: VoiceConnection,
  text: string,
  signal?: AbortSignal,
): SynthesizeSpeechOptions {
  return buildConfiguredTTSOptions(connection, text, {
    signal,
    language: VOICE_CALL_LANGUAGE,
  });
}

/** 普通回复和实时通话共用同一连接边界，调用方自行决定是否指定语言。 */
export function buildConfiguredTTSOptions(
  connection: VoiceConnection,
  text: string,
  options: { signal?: AbortSignal; language?: string } = {},
): SynthesizeSpeechOptions {
  const issue = voiceConnectionIssue(connection, "语音合成");
  if (issue) throw new Error(issue);

  const prompt = text.trim();
  if (!prompt) throw new Error("语音合成文字不能为空");

  return {
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    protocol: connection.protocol,
    ...(connection.ttsRoute ? { customRoute: connection.ttsRoute } : {}),
    model: connection.model.trim(),
    text: prompt,
    voiceId: defaultVoiceCallVoice(connection),
    speed: 1,
    ...(options.language ? { language: options.language } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function voiceConnectionIssue(connection: VoiceConnection, label: string): string {
  if (!connection.ready) return connection.reason || `${label}配置不可用`;
  if (!connection.model.trim()) return `请先选择${label}模型`;
  return "";
}
