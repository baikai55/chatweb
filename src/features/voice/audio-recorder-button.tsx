import { Loader2, Mic, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type AudioRecorderError,
  type RecordedAudio,
  type RecorderPhase,
} from "@/features/voice/browser-recorder";
import { useAudioRecorder } from "@/features/voice/use-audio-recorder";
import { cn } from "@/shared/lib/cn";

export type RecorderInteractionMode = "hold" | "toggle";

export type AudioRecorderButtonProps = {
  mode: RecorderInteractionMode;
  onRecorded: (result: RecordedAudio) => void;
  onError?: (error: AudioRecorderError) => void;
  onPhaseChange?: (phase: RecorderPhase) => void;
  disabled?: boolean;
  disabledReason?: string;
  minDurationMs?: number;
  /** 在按钮旁额外显示权限请求、计时和错误文字；按钮本身仍会显示录音计时。 */
  showStatus?: boolean;
  className?: string;
  containerClassName?: string;
};

export function formatRecordingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function AudioRecorderButton({
  mode,
  onRecorded,
  onError,
  onPhaseChange,
  disabled = false,
  disabledReason,
  minDurationMs,
  showStatus = false,
  className,
  containerClassName,
}: AudioRecorderButtonProps) {
  const { snapshot, start, stop, cancel, clearError } = useAudioRecorder({
    minDurationMs,
    onRecorded,
    onError,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const keyboardActiveRef = useRef(false);
  const ignoreNextClickRef = useRef(false);
  const virtualHoldRef = useRef(false);
  const previousModeRef = useRef(mode);
  const phaseRef = useRef(snapshot.phase);
  const onPhaseChangeRef = useRef(onPhaseChange);
  const statusId = useId();

  phaseRef.current = snapshot.phase;
  onPhaseChangeRef.current = onPhaseChange;

  const clearInteraction = useCallback((clearClickGuard = true) => {
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    keyboardActiveRef.current = false;
    if (clearClickGuard) ignoreNextClickRef.current = false;
    virtualHoldRef.current = false;
    if (pointerId === null) return;
    const button = buttonRef.current;
    try {
      if (button?.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
    } catch {
      // 页面切换时浏览器可能已经自行释放 pointer capture。
    }
  }, []);

  const cancelInteraction = useCallback(() => {
    clearInteraction();
    cancel();
  }, [cancel, clearInteraction]);

  useEffect(() => {
    if (previousModeRef.current !== mode) cancelInteraction();
    previousModeRef.current = mode;
  }, [cancelInteraction, mode]);

  useEffect(() => {
    if (disabled) cancelInteraction();
  }, [cancelInteraction, disabled]);

  useEffect(() => {
    // 保留键盘产生的 click guard；原生 click 可能晚于这次 idle 提交。
    if (snapshot.phase === "idle") clearInteraction(false);
  }, [clearInteraction, snapshot.error, snapshot.phase]);

  useEffect(() => {
    onPhaseChangeRef.current?.(snapshot.phase);
  }, [snapshot.phase]);

  useEffect(() => () => {
    if (phaseRef.current !== "idle") onPhaseChangeRef.current?.("idle");
  }, []);

  const beginRecording = useCallback(() => {
    clearError();
    void start();
  }, [clearError, start]);

  const releasePointer = useCallback((pointerId: number) => {
    activePointerIdRef.current = null;
    const button = buttonRef.current;
    try {
      if (button?.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
    } catch {
      // pointerup 之前也可能已由浏览器释放。
    }
  }, []);

  useEffect(() => {
    if (mode !== "hold" || typeof window === "undefined") return;
    const handleWindowPointerUp = (event: PointerEvent) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      releasePointer(event.pointerId);
      stop();
    };
    const handleWindowPointerCancel = (event: PointerEvent) => {
      if (activePointerIdRef.current !== event.pointerId) return;
      cancelInteraction();
    };

    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [cancelInteraction, mode, releasePointer, stop]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (mode !== "hold" || disabled || snapshot.phase !== "idle") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (activePointerIdRef.current !== null) return;
    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    virtualHoldRef.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 老版本 WebKit 可能不支持 capture，window 级清理仍会兜底。
    }
    beginRecording();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (mode !== "hold" || activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    releasePointer(event.pointerId);
    stop();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    cancelInteraction();
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    cancelInteraction();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (mode !== "hold" || disabled || !isActivationKey(event.key)) return;
    event.preventDefault();
    if (event.repeat || keyboardActiveRef.current || snapshot.phase !== "idle") return;
    keyboardActiveRef.current = true;
    ignoreNextClickRef.current = true;
    virtualHoldRef.current = false;
    beginRecording();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (mode !== "hold" || !isActivationKey(event.key) || !keyboardActiveRef.current) return;
    event.preventDefault();
    keyboardActiveRef.current = false;
    stop();
    globalThis.setTimeout(() => {
      ignoreNextClickRef.current = false;
    }, 0);
  };

  const handleBlur = () => {
    if (!keyboardActiveRef.current) return;
    cancelInteraction();
  };

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // 按住模式的鼠标/触摸 click 是 pointerup 的尾随事件，录音已在 pointerup 结束。
    // detail=0 则是屏幕阅读器的虚拟 click，需要保留为可访问的“点按开始/结束”。
    if (mode === "hold" && event.detail > 0) return;
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      return;
    }
    if (disabled || snapshot.phase === "stopping") return;
    event.preventDefault();

    // toggle 模式以及屏幕阅读器产生的虚拟 click 都采用“再点一次结束”。
    if (snapshot.phase === "idle") {
      virtualHoldRef.current = mode === "hold";
      beginRecording();
    } else {
      virtualHoldRef.current = false;
      stop();
    }
  };

  const isActive = snapshot.phase !== "idle";
  const elapsed = formatRecordingElapsed(snapshot.elapsedMs);
  const instruction = recorderInstruction(mode, snapshot.phase, virtualHoldRef.current);
  const activeStatus = snapshot.phase === "recording" || snapshot.phase === "stopping"
    ? `${instruction} ${elapsed}`
    : instruction;
  const status = disabled && disabledReason
    ? disabledReason
    : disabled
      ? "录音暂不可用"
      : snapshot.error?.message ?? activeStatus;
  const visibleStatus = snapshot.error || snapshot.phase !== "idle" ? status : "";

  return (
    <div className={cn("inline-flex min-w-0 items-center gap-2", containerClassName)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <Button
              ref={buttonRef}
              type="button"
              size="icon"
              variant={snapshot.error ? "destructive" : isActive ? "default" : "ghost"}
              className={cn("size-9 touch-none select-none rounded-full", className)}
              aria-label={status}
              aria-describedby={statusId}
              aria-pressed={mode === "toggle" || virtualHoldRef.current ? isActive : undefined}
              disabled={disabled || snapshot.phase === "stopping"}
              onClick={handleClick}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onLostPointerCapture={handleLostPointerCapture}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onBlur={handleBlur}
              onContextMenu={(event) => {
                if (mode === "hold") event.preventDefault();
              }}
            >
              {snapshot.phase === "requesting" ? (
                <Loader2 className="animate-spin" />
              ) : snapshot.phase === "recording" || snapshot.phase === "stopping" ? (
                <span className="flex flex-col items-center justify-center gap-0 leading-none" aria-hidden="true">
                  {snapshot.phase === "stopping" ? (
                    <Loader2 className="!size-3 animate-spin" />
                  ) : mode === "toggle" || virtualHoldRef.current ? (
                    <Square className="!size-3 fill-current" />
                  ) : (
                    <Mic className="!size-3 animate-pulse" />
                  )}
                  <span className="text-[9px] font-semibold leading-[10px]">{elapsed}</span>
                </span>
              ) : (
                <Mic />
              )}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{status}</TooltipContent>
      </Tooltip>

      <span
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn(
          "min-w-0 text-xs tabular-nums",
          snapshot.error ? "text-destructive" : "text-muted-foreground",
          !showStatus && "sr-only",
        )}
      >
        {visibleStatus}
      </span>
    </div>
  );
}

function isActivationKey(key: string): boolean {
  return key === " " || key === "Enter";
}

function recorderInstruction(
  mode: RecorderInteractionMode,
  phase: RecorderPhase,
  virtualHold: boolean,
): string {
  if (phase === "requesting") return "正在请求麦克风权限";
  if (phase === "stopping") return "正在结束录音";
  if (phase === "recording") {
    if (mode === "toggle" || virtualHold) return "点击结束录音";
    return "松开结束录音";
  }
  return mode === "hold" ? "按住说话" : "点击开始录音";
}
