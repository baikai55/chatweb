import {
  normalizeBaseURL,
  type Backend,
  type CustomTTSRoute,
  type VoiceProtocol,
} from "@/backends/types";

export type VoiceKind = "stt" | "tts";
export type ResolvedVoiceProtocol = Exclude<VoiceProtocol, "auto">;
export type VoiceConnectionSource =
  | "binding"
  | "legacy-stt-provider"
  | "legacy-current-backend";

export type VoiceConnection = {
  targetBackendId: string;
  baseURL: string;
  apiKey: string;
  model: string;
  protocol: ResolvedVoiceProtocol;
  source: VoiceConnectionSource;
  ready: boolean;
  reason: string;
  canListVoices: boolean;
  /** TTS 自定义路由；有值时优先于 protocol 对应的内置端点。 */
  ttsRoute?: CustomTTSRoute;
  /** 保留失效引用，便于设置页和错误提示定位。 */
  routeId?: string;
};

/**
 * 解析 STT/TTS 的实际请求后端。新 voiceRouting 优先；binding 尚未选择模型时，
 * 回落到上一版配置，保证 UI 分阶段迁移期间仍能继续使用。
 */
export function resolveVoiceConnection(
  owner: Backend,
  allBackends: Backend[],
  kind: VoiceKind,
): VoiceConnection {
  const binding = owner.voiceRouting[kind];
  const bindingModel = binding.model.trim();

  if (bindingModel) {
    const targetBackendId = binding.backendId.trim() || owner.id;
    const target = allBackends.find((backend) => backend.id === targetBackendId);
    const protocol = resolveProtocol(binding.protocol, target?.flavor);
    const routeId = kind === "tts" ? (binding.routeId ?? "").trim() : "";
    if (!target) {
      return unavailableConnection({
        targetBackendId,
        model: bindingModel,
        protocol,
        source: "binding",
        reason: `${kindLabel(kind)}引用的后端已不存在，请重新选择`,
        routeId: routeId || undefined,
      });
    }
    if (routeId) {
      const ttsRoute = target.customTTSRoutes.find((route) => route.id === routeId);
      if (!ttsRoute) {
        return {
          targetBackendId: target.id,
          baseURL: target.baseURL.trim(),
          apiKey: target.apiKey.trim(),
          model: bindingModel,
          protocol,
          source: "binding",
          ready: false,
          reason: "语音合成引用的自定义路由已不存在，请重新选择",
          canListVoices: false,
          routeId,
        };
      }
      return connectionFromBackend(target, bindingModel, protocol, "binding", true, kind, ttsRoute);
    }
    return connectionFromBackend(target, bindingModel, protocol, "binding", true, kind);
  }

  if (kind === "stt") return resolveLegacySTT(owner, allBackends);

  // 旧版 TTS 没有持久化模型；保留当前后端 + /tts，让面板继续用自己的模型选择。
  return connectionFromBackend(
    owner,
    "",
    "grok-native",
    "legacy-current-backend",
    false,
    "tts",
  );
}

function resolveLegacySTT(owner: Backend, allBackends: Backend[]): VoiceConnection {
  const legacy = owner.sttProvider;
  if (legacy.type === "openai-compatible") {
    const baseURL = normalizeBaseURL(legacy.baseURL);
    const model = legacy.model.trim();
    const matchingBackend = baseURL
      ? allBackends.find((backend) => (
          normalizeBaseURL(backend.baseURL) === baseURL
          && backend.apiKey === legacy.apiKey
        ))
      : undefined;

    if (matchingBackend) {
      return connectionFromBackend(
        matchingBackend,
        model,
        "openai-audio",
        "legacy-stt-provider",
        true,
        "stt",
      );
    }

    const ready = Boolean(baseURL && model);
    return {
      targetBackendId: "",
      baseURL,
      apiKey: legacy.apiKey.trim(),
      model,
      protocol: "openai-audio",
      source: "legacy-stt-provider",
      ready,
      reason: ready ? "" : "旧版独立语音转写配置缺少地址或模型",
      canListVoices: false,
    };
  }

  return connectionFromBackend(
    owner,
    owner.chatInputSTTModel.trim(),
    "grok-native",
    "legacy-current-backend",
    true,
    "stt",
  );
}

function connectionFromBackend(
  backend: Backend,
  model: string,
  protocol: ResolvedVoiceProtocol,
  source: VoiceConnectionSource,
  requireModel: boolean,
  kind: VoiceKind,
  ttsRoute?: CustomTTSRoute,
): VoiceConnection {
  const baseURL = backend.baseURL.trim();
  const common = {
    targetBackendId: backend.id,
    baseURL,
    apiKey: backend.apiKey.trim(),
    model,
    protocol,
    source,
    canListVoices: !ttsRoute && protocol === "grok-native",
    ...(ttsRoute ? { ttsRoute, routeId: ttsRoute.id } : {}),
  };

  if (backend.mode === "proxy") {
    return {
      ...common,
      ready: false,
      reason: "所选后端使用 proxy 模式，当前语音请求尚未接入 Worker 代理",
    };
  }
  if (!baseURL) {
    return { ...common, ready: false, reason: `${kindLabel(kind)}后端地址为空` };
  }
  if (requireModel && !model) {
    return { ...common, ready: false, reason: `尚未选择${kindLabel(kind)}模型` };
  }
  return { ...common, ready: true, reason: "" };
}

function unavailableConnection(options: {
  targetBackendId: string;
  model: string;
  protocol: ResolvedVoiceProtocol;
  source: VoiceConnectionSource;
  reason: string;
  routeId?: string;
}): VoiceConnection {
  return {
    targetBackendId: options.targetBackendId,
    baseURL: "",
    apiKey: "",
    model: options.model,
    protocol: options.protocol,
    source: options.source,
    ready: false,
    reason: options.reason,
    canListVoices: options.protocol === "grok-native",
    ...(options.routeId ? { routeId: options.routeId } : {}),
  };
}

function resolveProtocol(
  requested: VoiceProtocol,
  flavor: Backend["flavor"] | undefined,
): ResolvedVoiceProtocol {
  if (requested !== "auto") return requested;
  return flavor === "grok2api" ? "grok-native" : "openai-audio";
}

function kindLabel(kind: VoiceKind): string {
  return kind === "stt" ? "语音转写" : "语音合成";
}
