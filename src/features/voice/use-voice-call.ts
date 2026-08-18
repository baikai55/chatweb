import { useCallback, useEffect, useRef, useState } from "react";

import { isAbortError } from "@/transport/errors";
import { releaseSpeechAudio, synthesizeSpeech, transcribeSpeech, type SpeechAudioResult } from "@/transport/voice";
import { prepareRecordedSTTAudioFile, validateSTTAudioFile } from "@/features/voice/audio-file";
import {
  VoiceCallRecorder,
  type VoiceCallRecorderResult,
} from "@/features/voice/voice-call-recorder";
import {
  buildVoiceCallTTSOptions,
  type VoiceCallConfig,
} from "@/features/voice/voice-call-config";
import type { VoiceCallPhase } from "@/features/voice/voice-call-overlay";

const SILENT_AUDIO_DATA_URL = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export type VoiceCallAssistantTurnResult = {
  status: "completed" | "aborted" | "failed" | "stale";
  text: string;
  error?: string;
};

export type UseVoiceCallOptions = {
  config: VoiceCallConfig;
  contextKey: string;
  onAssistantTurn: (text: string) => Promise<VoiceCallAssistantTurnResult>;
  onAbortAssistant: () => void;
};

export type VoiceCallState = {
  open: boolean;
  phase: VoiceCallPhase;
  elapsedMs: number;
  muted: boolean;
  soundEnabled: boolean;
  latestUserText: string;
  latestAssistantText: string;
  error: string;
};

const INITIAL_STATE: VoiceCallState = {
  open: false,
  phase: "preparing",
  elapsedMs: 0,
  muted: false,
  soundEnabled: false,
  latestUserText: "",
  latestAssistantText: "",
  error: "",
};

/**
 * 半双工语音通话：监听一轮，识别并请求聊天回复，播完后再进入下一轮。
 * 所有异步阶段都用 call sequence 隔离，结束通话或切换会话后旧结果不会再播放。
 */
export function useVoiceCall({
  config,
  contextKey,
  onAssistantTurn,
  onAbortAssistant,
}: UseVoiceCallOptions) {
  const [state, setState] = useState<VoiceCallState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const configRef = useRef(config);
  configRef.current = config;
  const onAssistantTurnRef = useRef(onAssistantTurn);
  onAssistantTurnRef.current = onAssistantTurn;
  const onAbortAssistantRef = useRef(onAbortAssistant);
  onAbortAssistantRef.current = onAbortAssistant;

  const callSequenceRef = useRef(0);
  const recorderRef = useRef<VoiceCallRecorder | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechResultRef = useRef<SpeechAudioResult | null>(null);
  const startedAtRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mutedRef = useRef(false);
  const soundEnabledRef = useRef(false);

  const patchState = useCallback((patch: Partial<VoiceCallState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  }, []);

  const isCurrent = useCallback((sequence: number) => (
    callSequenceRef.current === sequence && stateRef.current.open
  ), []);

  const releaseCurrentSpeech = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
    }
    releaseSpeechAudio(speechResultRef.current);
    speechResultRef.current = null;
  }, []);

  const stopElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current === null) return;
    clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }, []);

  const cleanupActiveCall = useCallback((abortAssistant: boolean) => {
    callSequenceRef.current += 1;
    recorderRef.current?.dispose();
    recorderRef.current = null;
    sttAbortRef.current?.abort();
    sttAbortRef.current = null;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    if (abortAssistant) onAbortAssistantRef.current();
    releaseCurrentSpeech();
    audioRef.current = null;
    stopElapsedTimer();
  }, [releaseCurrentSpeech, stopElapsedTimer]);

  const failCall = useCallback((sequence: number, caught: unknown) => {
    if (!isCurrent(sequence) || isAbortError(caught)) return;
    patchState({
      phase: "error",
      error: caught instanceof Error ? caught.message : String(caught),
    });
  }, [isCurrent, patchState]);

  const armListeningRef = useRef<(sequence: number) => Promise<void>>(async () => undefined);

  const playSpeech = useCallback(async (sequence: number, result: SpeechAudioResult) => {
    if (!isCurrent(sequence)) {
      releaseSpeechAudio(result);
      return;
    }
    if (!soundEnabledRef.current || mutedRef.current) {
      releaseSpeechAudio(result);
      if (mutedRef.current) patchState({ phase: "paused" });
      else await armListeningRef.current(sequence);
      return;
    }

    releaseCurrentSpeech();
    speechResultRef.current = result;
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    audio.preload = "auto";
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audio.muted = false;
    audio.src = result.url;
    audio.onended = () => {
      if (!isCurrent(sequence)) return;
      releaseCurrentSpeech();
      if (!mutedRef.current) void armListeningRef.current(sequence);
      else patchState({ phase: "paused" });
    };
    audio.onerror = () => {
      if (!isCurrent(sequence)) return;
      failCall(sequence, new Error("语音回复无法播放，请重试"));
    };
    patchState({ phase: "speaking", error: "" });

    try {
      await audio.play();
    } catch (caught) {
      if (!isCurrent(sequence)) return;
      const detail = caught instanceof Error ? caught.message : String(caught);
      failCall(sequence, new Error(`浏览器阻止了语音自动播放，请点重试继续播放。${detail}`));
    }
  }, [failCall, isCurrent, patchState, releaseCurrentSpeech]);

  const synthesizeReply = useCallback(async (sequence: number, text: string) => {
    if (!isCurrent(sequence) || !soundEnabledRef.current || mutedRef.current) {
      if (isCurrent(sequence)) {
        if (mutedRef.current) patchState({ phase: "paused" });
        else await armListeningRef.current(sequence);
      }
      return;
    }
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    try {
      const result = await synthesizeSpeech(buildVoiceCallTTSOptions(
        configRef.current.ttsConnection,
        text,
        controller.signal,
      ));
      if (!isCurrent(sequence) || ttsAbortRef.current !== controller) {
        releaseSpeechAudio(result);
        return;
      }
      ttsAbortRef.current = null;
      await playSpeech(sequence, result);
    } catch (caught) {
      if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
      failCall(sequence, caught);
    }
  }, [failCall, isCurrent, patchState, playSpeech]);

  const processRecording = useCallback(async (
    sequence: number,
    result: Extract<VoiceCallRecorderResult, { kind: "recorded" }>,
  ) => {
    if (!isCurrent(sequence)) return;
    patchState({ phase: "transcribing", error: "" });
    const controller = new AbortController();
    sttAbortRef.current = controller;

    try {
      const audioFile = await prepareRecordedSTTAudioFile(
        result.recording.file,
        result.recording.durationMs,
        { signal: controller.signal },
      );
      const validationError = await validateSTTAudioFile(audioFile);
      if (validationError) throw new Error(validationError);
      if (!isCurrent(sequence) || sttAbortRef.current !== controller) return;

      const connection = configRef.current.sttConnection;
      const transcriptionResult = await transcribeSpeech({
        baseURL: connection.baseURL,
        apiKey: connection.apiKey,
        protocol: connection.protocol,
        model: connection.model,
        file: audioFile,
        signal: controller.signal,
      });
      if (!isCurrent(sequence) || sttAbortRef.current !== controller) return;
      sttAbortRef.current = null;
      const transcription = transcriptionResult.text.trim();
      if (!transcription) {
        if (mutedRef.current) patchState({ phase: "paused" });
        else await armListeningRef.current(sequence);
        return;
      }

      patchState({ phase: "thinking", latestUserText: transcription, error: "" });
      const turn = await onAssistantTurnRef.current(transcription);
      if (!isCurrent(sequence)) return;
      if (turn.status === "stale" || turn.status === "aborted") {
        if (mutedRef.current) patchState({ phase: "paused" });
        else await armListeningRef.current(sequence);
        return;
      }
      if (turn.status === "failed") throw new Error(turn.error || "聊天回复失败");
      const reply = turn.text.trim();
      if (!reply) throw new Error("聊天模型没有返回可播报的文字");
      patchState({ latestAssistantText: reply });
      await synthesizeReply(sequence, reply);
    } catch (caught) {
      if (sttAbortRef.current === controller) sttAbortRef.current = null;
      failCall(sequence, caught);
    }
  }, [failCall, isCurrent, patchState, synthesizeReply]);

  const handleRecorderResult = useCallback((sequence: number, result: VoiceCallRecorderResult) => {
    if (!isCurrent(sequence)) return;
    if (result.kind === "no-speech") {
      if (!mutedRef.current) void armListeningRef.current(sequence);
      else patchState({ phase: "paused" });
      return;
    }
    void processRecording(sequence, result);
  }, [isCurrent, patchState, processRecording]);

  const armListening = useCallback(async (sequence: number) => {
    if (!isCurrent(sequence)) return;
    if (mutedRef.current) {
      patchState({ phase: "paused" });
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder) return;
    const currentSnapshot = recorder.getSnapshot();
    if (currentSnapshot.phase === "listening") {
      patchState({ phase: "listening", error: "" });
      return;
    }
    if (currentSnapshot.phase !== "idle") return;
    patchState({ phase: "preparing", error: "" });
    try {
      await recorder.start();
      if (!isCurrent(sequence)) return;
      const snapshot = recorder.getSnapshot();
      if (snapshot.error) throw new Error(snapshot.error.message);
      if (snapshot.phase === "listening") patchState({ phase: "listening" });
    } catch (caught) {
      failCall(sequence, caught);
    }
  }, [failCall, isCurrent, patchState]);
  armListeningRef.current = armListening;

  const start = useCallback((): { ok: boolean; reason: string } => {
    const currentConfig = configRef.current;
    if (!currentConfig.ready) return { ok: false, reason: currentConfig.reason };

    cleanupActiveCall(false);
    const sequence = callSequenceRef.current + 1;
    callSequenceRef.current = sequence;
    mutedRef.current = false;
    soundEnabledRef.current = false;
    startedAtRef.current = Date.now();
    const audio = new Audio();
    audio.preload = "auto";
    (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    unlockAudioElement(audio);
    audioRef.current = audio;
    patchState({
      ...INITIAL_STATE,
      open: true,
      phase: "preparing",
    });

    const recorder = new VoiceCallRecorder({
      onResult: (result) => handleRecorderResult(sequence, result),
      onError: (error) => failCall(sequence, new Error(error.message)),
    });
    recorderRef.current = recorder;
    elapsedTimerRef.current = setInterval(() => {
      if (!isCurrent(sequence)) return;
      patchState({ elapsedMs: Math.max(0, Date.now() - startedAtRef.current) });
    }, 1_000);
    void armListening(sequence);
    return { ok: true, reason: "" };
  }, [armListening, cleanupActiveCall, failCall, handleRecorderResult, isCurrent, patchState]);

  const end = useCallback(() => {
    if (!stateRef.current.open) return;
    cleanupActiveCall(true);
    mutedRef.current = false;
    soundEnabledRef.current = false;
    setState(INITIAL_STATE);
    stateRef.current = INITIAL_STATE;
  }, [cleanupActiveCall]);

  const toggleMute = useCallback(() => {
    if (!stateRef.current.open) return;
    const nextMuted = !mutedRef.current;
    const currentPhase = stateRef.current.phase;
    mutedRef.current = nextMuted;
    patchState({
      muted: nextMuted,
      ...(nextMuted && (currentPhase === "preparing" || currentPhase === "listening" || currentPhase === "error")
        ? { phase: "paused" as const }
        : {}),
    });
    if (nextMuted) {
      if (recorderRef.current?.getSnapshot().phase !== "idle") recorderRef.current?.cancel();
      return;
    }
    const phase = stateRef.current.phase;
    if (phase === "paused" || phase === "error") {
      void armListeningRef.current(callSequenceRef.current);
    }
  }, [patchState]);

  const interrupt = useCallback(() => {
    if (!stateRef.current.open) return;
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    releaseCurrentSpeech();
    if (!mutedRef.current) void armListeningRef.current(callSequenceRef.current);
    else patchState({ phase: "paused" });
  }, [patchState, releaseCurrentSpeech]);

  const toggleSound = useCallback(() => {
    if (!stateRef.current.open) return;
    const nextEnabled = !soundEnabledRef.current;
    soundEnabledRef.current = nextEnabled;
    patchState({ soundEnabled: nextEnabled });
    if (!nextEnabled && (ttsAbortRef.current || speechResultRef.current)) interrupt();
  }, [interrupt, patchState]);

  const retry = useCallback(() => {
    if (!stateRef.current.open) return;
    const audio = audioRef.current;
    if (speechResultRef.current && audio?.src) {
      patchState({ phase: "speaking", error: "" });
      void audio.play().catch((caught) => failCall(callSequenceRef.current, caught));
      return;
    }
    patchState({ error: "" });
    void armListeningRef.current(callSequenceRef.current);
  }, [failCall, patchState]);

  const finishSpeaking = useCallback(() => {
    recorderRef.current?.forceStop();
  }, []);

  useEffect(() => {
    if (!stateRef.current.open) return;
    cleanupActiveCall(true);
    stateRef.current = INITIAL_STATE;
    setState(INITIAL_STATE);
  }, [cleanupActiveCall, contextKey]);

  useEffect(() => () => {
    if (stateRef.current.open) cleanupActiveCall(true);
  }, [cleanupActiveCall]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== "hidden" || !stateRef.current.open) return;
      mutedRef.current = true;
      recorderRef.current?.cancel();
      ttsAbortRef.current?.abort();
      ttsAbortRef.current = null;
      releaseCurrentSpeech();
      patchState({ muted: true, phase: "paused" });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [patchState, releaseCurrentSpeech]);

  useEffect(() => {
    const handlePageHide = () => {
      if (!stateRef.current.open) return;
      cleanupActiveCall(true);
      stateRef.current = INITIAL_STATE;
      setState(INITIAL_STATE);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [cleanupActiveCall]);

  return {
    state,
    start,
    end,
    toggleMute,
    toggleSound,
    interrupt,
    retry,
    finishSpeaking,
  };
}

/** 在“开始通话”的点击手势里预播放极短静音，解锁后续异步 TTS 的同一音频元素。 */
function unlockAudioElement(audio: HTMLAudioElement): void {
  audio.muted = true;
  audio.src = SILENT_AUDIO_DATA_URL;
  void audio.play().then(() => {
    if (audio.src !== SILENT_AUDIO_DATA_URL) return;
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute("src");
    audio.muted = false;
  }).catch(() => {
    // 个别浏览器连静音 data URL 也不接受，真实播放时仍有错误态的手动重试兜底。
    if (audio.src !== SILENT_AUDIO_DATA_URL) return;
    audio.removeAttribute("src");
    audio.muted = false;
  });
}
