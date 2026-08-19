/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unlockAudioElement } from "@/features/voice/browser-audio";
import { useChatReplySpeech } from "@/features/voice/use-chat-reply-speech";
import { loadAppSettings, patchAppSettings } from "@/shared/settings/app-settings";
import type { VoiceConnection } from "@/transport/voice-routing";

vi.mock("@/features/voice/browser-audio", () => ({
  unlockAudioElement: vi.fn(),
}));

const connection: VoiceConnection = {
  targetBackendId: "speech",
  baseURL: "https://speech.example.test/v1",
  apiKey: "test-key",
  model: "tts-model",
  protocol: "openai-audio",
  source: "binding",
  ready: true,
  reason: "",
  canListVoices: false,
};

type HookValue = ReturnType<typeof useChatReplySpeech>;

const roots: Root[] = [];

async function renderHook(): Promise<{ get: () => HookValue; unmount: () => Promise<void> }> {
  let value: HookValue | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  function Harness() {
    value = useChatReplySpeech({ connection, contextKey: "backend:session", onError: vi.fn() });
    return null;
  }

  await act(async () => { root.render(createElement(Harness)); });
  return {
    get: () => {
      if (!value) throw new Error("hook 尚未渲染");
      return value;
    },
    unmount: async () => {
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

beforeEach(() => {
  patchAppSettings({ chatReplySpeechEnabled: false });
  vi.mocked(unlockAudioElement).mockReset();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  patchAppSettings({ chatReplySpeechEnabled: false });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useChatReplySpeech", () => {
  it("开启后在聊天面板卸载和重新挂载之间保持开启，直到用户主动关闭", async () => {
    const first = await renderHook();
    expect(first.get().enabled).toBe(false);

    act(() => {
      expect(first.get().toggle()).toEqual({ ok: true, reason: "" });
    });
    expect(first.get().enabled).toBe(true);
    expect(loadAppSettings().chatReplySpeechEnabled).toBe(true);

    await first.unmount();
    const second = await renderHook();
    expect(second.get().enabled).toBe(true);

    vi.mocked(unlockAudioElement).mockClear();
    act(() => { second.get().prepare(); });
    expect(unlockAudioElement).toHaveBeenCalledOnce();

    act(() => {
      expect(second.get().toggle()).toEqual({ ok: true, reason: "" });
    });
    expect(second.get().enabled).toBe(false);
    expect(loadAppSettings().chatReplySpeechEnabled).toBe(false);
  });

  it("关闭偏好保存失败时保持开启且不中断当前播放器", async () => {
    const hook = await renderHook();
    act(() => { hook.get().toggle(); });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    let result: ReturnType<HookValue["toggle"]> | undefined;
    act(() => { result = hook.get().toggle(); });

    expect(result).toMatchObject({ ok: false });
    expect(hook.get().enabled).toBe(true);
    expect(loadAppSettings().chatReplySpeechEnabled).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
