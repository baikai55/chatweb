import { useCallback, useEffect, useRef, useState } from "react";

import { unlockAudioElement } from "@/features/voice/browser-audio";
import { buildConfiguredTTSOptions } from "@/features/voice/voice-call-config";
import { isAbortError } from "@/transport/errors";
import { releaseSpeechAudio, synthesizeSpeech, type SpeechAudioResult } from "@/transport/voice";
import type { VoiceConnection } from "@/transport/voice-routing";

export type ChatReplySpeechPhase = "idle" | "synthesizing" | "speaking";

export type ChatReplySpeechToggleResult = {
  ok: boolean;
  reason: string;
};

export function useChatReplySpeech({
  connection,
  contextKey,
  onError,
}: {
  connection: VoiceConnection;
  contextKey: string;
  onError: (message: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<ChatReplySpeechPhase>("idle");
  const enabledRef = useRef(false);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const sequenceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resultRef = useRef<SpeechAudioResult | null>(null);

  const releaseCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
    }
    releaseSpeechAudio(resultRef.current);
    resultRef.current = null;
  }, []);

  const stop = useCallback(() => {
    sequenceRef.current += 1;
    releaseCurrent();
    setPhase("idle");
  }, [releaseCurrent]);

  const toggle = useCallback((): ChatReplySpeechToggleResult => {
    if (enabledRef.current) {
      enabledRef.current = false;
      setEnabled(false);
      stop();
      return { ok: true, reason: "" };
    }

    const current = connectionRef.current;
    if (!current.ready || !current.model.trim()) {
      return {
        ok: false,
        reason: current.reason || "请先在设置的“语音”页选择语音合成供应商和模型",
      };
    }

    const audio = audioRef.current ?? new Audio();
    audio.preload = "auto";
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioRef.current = audio;
    unlockAudioElement(audio);
    enabledRef.current = true;
    setEnabled(true);
    return { ok: true, reason: "" };
  }, [stop]);

  const speak = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!enabledRef.current || !prompt) return;

    const connectionSnapshot = connectionRef.current;
    if (!connectionSnapshot.ready || !connectionSnapshot.model.trim()) {
      onErrorRef.current(connectionSnapshot.reason || "语音合成配置不可用");
      return;
    }

    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    releaseCurrent();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("synthesizing");

    try {
      const result = await synthesizeSpeech(buildConfiguredTTSOptions(
        connectionSnapshot,
        prompt,
        { signal: controller.signal },
      ));
      if (sequenceRef.current !== sequence || !enabledRef.current || abortRef.current !== controller) {
        releaseSpeechAudio(result);
        return;
      }

      abortRef.current = null;
      resultRef.current = result;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.preload = "auto";
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      audio.muted = false;
      audio.src = result.url;
      audio.onended = () => {
        if (sequenceRef.current !== sequence) return;
        releaseCurrent();
        setPhase("idle");
      };
      audio.onerror = () => {
        if (sequenceRef.current !== sequence) return;
        sequenceRef.current += 1;
        releaseCurrent();
        setPhase("idle");
        onErrorRef.current("语音回复无法播放");
      };
      setPhase("speaking");
      await audio.play();
    } catch (caught) {
      // 某些浏览器会同时触发 media error 和 play() rejection；前者已负责清理和提示。
      if (
        sequenceRef.current !== sequence
        || isAbortError(caught)
        || (abortRef.current !== controller && resultRef.current === null)
      ) return;
      releaseCurrent();
      setPhase("idle");
      onErrorRef.current(caught instanceof Error ? caught.message : String(caught));
    }
  }, [releaseCurrent]);

  useEffect(() => {
    enabledRef.current = false;
    setEnabled(false);
    stop();
  }, [contextKey, stop]);

  useEffect(() => () => {
    enabledRef.current = false;
    sequenceRef.current += 1;
    releaseCurrent();
  }, [releaseCurrent]);

  return { enabled, phase, toggle, speak, stop };
}
