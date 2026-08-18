import {
  AudioLines,
  CircleAlert,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/cn";

export type VoiceCallPhase =
  | "preparing"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused"
  | "error";

export type VoiceCallOverlayProps = {
  open: boolean;
  phase: VoiceCallPhase;
  modelName: string;
  elapsedMs: number;
  muted: boolean;
  soundEnabled: boolean;
  latestUserText?: string;
  latestAssistantText?: string;
  error?: string;
  onToggleMute: () => void;
  onToggleSound: () => void;
  onInterrupt: () => void;
  onFinishSpeaking: () => void;
  onRetry: () => void;
  onEnd: () => void;
};

type PhasePresentation = {
  label: string;
  detail: string;
  icon: LucideIcon;
  busy?: boolean;
};

const PHASE_PRESENTATIONS: Record<VoiceCallPhase, PhasePresentation> = {
  preparing: {
    label: "正在连接",
    detail: "正在准备麦克风和语音服务",
    icon: Loader2,
    busy: true,
  },
  listening: {
    label: "正在听",
    detail: "请直接说话",
    icon: Mic,
  },
  transcribing: {
    label: "正在识别",
    detail: "正在把这段话转成文字",
    icon: Loader2,
    busy: true,
  },
  thinking: {
    label: "正在回复",
    detail: "对方正在组织回答",
    icon: Loader2,
    busy: true,
  },
  speaking: {
    label: "正在说话",
    detail: "点击可打断回复",
    icon: AudioLines,
  },
  paused: {
    label: "已暂停聆听",
    detail: "打开麦克风后继续通话",
    icon: MicOff,
  },
  error: {
    label: "通话出现问题",
    detail: "可以继续通话或结束",
    icon: CircleAlert,
  },
};

export function VoiceCallOverlay({
  open,
  phase,
  modelName,
  elapsedMs,
  muted,
  soundEnabled,
  latestUserText,
  latestAssistantText,
  error,
  onToggleMute,
  onToggleSound,
  onInterrupt,
  onFinishSpeaking,
  onRetry,
  onEnd,
}: VoiceCallOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const hasError = phase === "error" || Boolean(error?.trim());
  const presentation = hasError
    ? PHASE_PRESENTATIONS.error
    : PHASE_PRESENTATIONS[phase];
  const PhaseIcon = presentation.icon;
  const assistantName = modelName.trim() || "语音助手";
  const isSpeaking = phase === "speaking" && !muted && !hasError;
  const isListening = phase === "listening" && !muted && !hasError;
  const controlsDisabled = phase === "preparing" || hasError;

  function keepFocusInside(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const statusControl = (
    <>
      <span
        className={cn(
          "flex size-28 items-center justify-center rounded-full border bg-secondary text-foreground shadow-sm",
          hasError && "border-destructive/40 bg-destructive/5 text-destructive",
          isSpeaking && "border-primary/30 bg-primary/5",
        )}
      >
        <PhaseIcon className={cn("!size-10", presentation.busy && "animate-spin")} />
      </span>
      <span className="mt-5 text-xl font-medium">{presentation.label}</span>
      <span className="mt-1 text-sm text-muted-foreground">{presentation.detail}</span>
    </>
  );

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`与 ${assistantName} 的语音通话`}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex h-dvh flex-col overflow-hidden bg-background text-foreground outline-none safe-area-top safe-area-bottom"
      onKeyDown={keepFocusInside}
    >
      <header className="flex h-14 shrink-0 items-center justify-center border-b px-4">
        <div className="text-center">
          <p className="text-xs text-muted-foreground">语音通话</p>
          <p className="mt-0.5 text-sm font-medium tabular-nums">{formatElapsed(elapsedMs)}</p>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col items-center justify-center">
          <p className="max-w-full truncate text-base font-medium" title={assistantName}>{assistantName}</p>

          <div className="mt-7 flex flex-col items-center text-center">
            <span className="sr-only" role="status" aria-live="polite">
              {presentation.label}。{presentation.detail}
            </span>
            {isSpeaking || isListening ? (
              <button
                type="button"
                className="flex flex-col items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={isSpeaking ? "打断语音回复" : "结束本轮录音"}
                onClick={isSpeaking ? onInterrupt : onFinishSpeaking}
              >
                {statusControl}
              </button>
            ) : statusControl}
          </div>

          {hasError ? (
            <div className="mt-6 flex w-full max-w-md flex-col items-center gap-4 text-center">
              {error?.trim() ? (
                <p role="alert" className="max-w-full whitespace-pre-wrap break-words text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="button" variant="outline" className="h-11 gap-2 px-5" onClick={onRetry}>
                <RotateCcw className="size-4" />
                继续通话
              </Button>
            </div>
          ) : (
            <ConversationSummary
              latestUserText={latestUserText}
              latestAssistantText={latestAssistantText}
            />
          )}
        </div>
      </main>

      <footer className="shrink-0 border-t bg-background px-5 pb-5 pt-4">
        <div className="mx-auto grid w-full max-w-sm grid-cols-3 gap-3">
          <CallControl
            label={muted ? "打开麦克风" : "关闭麦克风"}
            icon={muted ? MicOff : Mic}
            active={muted}
            disabled={controlsDisabled}
            onClick={onToggleMute}
          />
          <CallControl label="结束通话" icon={PhoneOff} destructive onClick={onEnd} />
          <CallControl
            label={soundEnabled ? "关闭回复声音" : "打开回复声音"}
            icon={soundEnabled ? Volume2 : VolumeX}
            active={!soundEnabled}
            disabled={controlsDisabled}
            onClick={onToggleSound}
          />
        </div>
      </footer>
    </div>
  );
}

function ConversationSummary({
  latestUserText,
  latestAssistantText,
}: Pick<VoiceCallOverlayProps, "latestUserText" | "latestAssistantText">) {
  const userText = latestUserText?.trim();
  const assistantText = latestAssistantText?.trim();
  if (!userText && !assistantText) return <div className="min-h-24" aria-hidden="true" />;

  return (
    <section className="mt-7 min-h-24 w-full max-w-md space-y-3" aria-label="最近一轮对话">
      {userText ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">你</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6">{userText}</p>
        </div>
      ) : null}
      {assistantText ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">助手</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6">{assistantText}</p>
        </div>
      ) : null}
    </section>
  );
}

function CallControl({
  label,
  icon: Icon,
  active = false,
  destructive = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant={destructive ? "destructive" : active ? "secondary" : "outline"}
        className="size-14 shrink-0 rounded-full [&_svg]:!size-5"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon />
      </Button>
      <span className="w-full text-center text-xs leading-4 text-muted-foreground">{label}</span>
    </div>
  );
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(elapsedMs) ? elapsedMs / 1000 : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}
