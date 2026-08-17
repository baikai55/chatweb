import { useCallback, useEffect, useRef, useState } from "react";

import {
  BrowserAudioRecorder,
  type AudioRecorderError,
  type BrowserAudioRecorderOptions,
  type RecordedAudio,
  type RecorderEnvironment,
  type RecorderSnapshot,
} from "@/features/voice/browser-recorder";

const IDLE_SNAPSHOT: RecorderSnapshot = {
  phase: "idle",
  elapsedMs: 0,
  error: null,
};

export type UseAudioRecorderOptions = {
  minDurationMs?: number;
  onRecorded: (result: RecordedAudio) => void;
  onError?: (error: AudioRecorderError) => void;
  /** 仅供测试或非浏览器宿主注入。 */
  environment?: RecorderEnvironment;
};

export type AudioRecorderControls = {
  snapshot: RecorderSnapshot;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
};

/**
 * 把浏览器录音状态机接到 React，并负责页面离开、隐藏和组件卸载时释放麦克风。
 */
export function useAudioRecorder(options: UseAudioRecorderOptions): AudioRecorderControls {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const recorderRef = useRef<BrowserAudioRecorder | null>(null);
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(IDLE_SNAPSHOT);
  const { environment, minDurationMs } = options;

  useEffect(() => {
    const recorderOptions: BrowserAudioRecorderOptions = {
      minDurationMs,
      environment,
      onRecorded: (result) => optionsRef.current.onRecorded(result),
      onError: (error) => optionsRef.current.onError?.(error),
    };
    const recorder = new BrowserAudioRecorder(recorderOptions);
    recorderRef.current = recorder;
    setSnapshot(recorder.getSnapshot());
    const unsubscribe = recorder.subscribe(() => setSnapshot(recorder.getSnapshot()));

    return () => {
      unsubscribe();
      recorder.dispose();
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, [environment, minDurationMs]);

  const start = useCallback(async () => {
    await recorderRef.current?.start();
  }, []);

  const stop = useCallback(() => recorderRef.current?.stop(), []);
  const cancel = useCallback(() => recorderRef.current?.cancel(), []);
  const clearError = useCallback(() => recorderRef.current?.clearError(), []);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const cancelForPageExit = () => recorderRef.current?.cancel();
    const cancelWhenHidden = () => {
      if (document.hidden) cancelForPageExit();
    };

    document.addEventListener("visibilitychange", cancelWhenHidden);
    window.addEventListener("pagehide", cancelForPageExit);
    return () => {
      document.removeEventListener("visibilitychange", cancelWhenHidden);
      window.removeEventListener("pagehide", cancelForPageExit);
    };
  }, []);

  return { snapshot, start, stop, cancel, clearError };
}
