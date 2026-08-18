export type RecorderPhase = "idle" | "requesting" | "recording" | "stopping";

export type RecorderErrorCode =
  | "unsupported"
  | "insecure-context"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "interrupted"
  | "encoding-failed"
  | "too-short"
  | "empty-recording";

export type AudioRecorderError = {
  code: RecorderErrorCode;
  message: string;
  cause?: unknown;
};

export type RecordedAudio = {
  file: File;
  durationMs: number;
  mimeType: string;
};

export type RecorderSnapshot = {
  phase: RecorderPhase;
  elapsedMs: number;
  error: AudioRecorderError | null;
};

export type RecorderEnvironment = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  mediaRecorder?: typeof MediaRecorder;
  secureContext?: boolean;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type BrowserAudioRecorderOptions = {
  minDurationMs?: number;
  onRecorded: (result: RecordedAudio) => void;
  onError?: (error: AudioRecorderError) => void;
  environment?: RecorderEnvironment;
};

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg",
] as const;

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

const STOP_WATCHDOG_MS = 2_000;

export function preferredRecordingMimeType(mediaRecorder: typeof MediaRecorder): string {
  if (typeof mediaRecorder.isTypeSupported !== "function") return "";
  return MIME_CANDIDATES.find((mime) => mediaRecorder.isTypeSupported(mime)) ?? "";
}

export function normalizeRecordingMimeType(value: string): string {
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "audio/x-m4a") return "audio/mp4";
  if (mime === "audio/opus" || mime === "application/ogg") return "audio/ogg";
  return mime.startsWith("audio/") ? mime : "audio/webm";
}

export function recordingFileExtension(mimeType: string): string {
  const mime = normalizeRecordingMimeType(mimeType);
  if (mime === "audio/mp4") return "m4a";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/aac") return "aac";
  return "webm";
}

export function mapRecorderError(cause: unknown): AudioRecorderError {
  const name = typeof DOMException !== "undefined" && cause instanceof DOMException
    ? cause.name
    : cause && typeof cause === "object" && "name" in cause
      ? String((cause as { name?: unknown }).name ?? "")
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { code: "permission-denied", message: "没有麦克风权限，请在浏览器站点设置里允许访问", cause };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return { code: "no-device", message: "没有找到可用的麦克风", cause };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return { code: "device-busy", message: "麦克风正被其它应用占用，或系统暂时无法读取", cause };
  }
  if (name === "AbortError") {
    return { code: "interrupted", message: "录音被系统中断，请重试", cause };
  }
  return { code: "encoding-failed", message: "无法开始或编码录音，请换一个浏览器重试", cause };
}

export class BrowserAudioRecorder {
  private snapshot: RecorderSnapshot = { phase: "idle", elapsedMs: 0, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly minDurationMs: number;
  private readonly onRecorded: (result: RecordedAudio) => void;
  private readonly onError?: (error: AudioRecorderError) => void;
  private readonly environment: RecorderEnvironment;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stoppedDurationMs: number | null = null;
  private session = 0;
  private discard = false;
  private disposed = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private watchdogId: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BrowserAudioRecorderOptions) {
    this.minDurationMs = options.minDurationMs ?? 300;
    this.onRecorded = options.onRecorded;
    this.onError = options.onError;
    this.environment = options.environment ?? {};
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): RecorderSnapshot => this.snapshot;

  clearError(): void {
    if (!this.snapshot.error) return;
    this.publish({ ...this.snapshot, error: null });
  }

  async start(): Promise<void> {
    if (this.disposed || this.snapshot.phase !== "idle") return;
    const mediaRecorder = this.environment.mediaRecorder ?? globalThis.MediaRecorder;
    const getUserMedia = this.environment.getUserMedia
      ?? (typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices) : undefined);
    const secureContext = this.environment.secureContext ?? globalThis.isSecureContext;

    if (secureContext === false) {
      this.report({ code: "insecure-context", message: "浏览器只允许在 HTTPS 或 localhost 使用麦克风" });
      return;
    }
    if (!mediaRecorder || !getUserMedia) {
      this.report({ code: "unsupported", message: "当前浏览器不支持麦克风录音" });
      return;
    }

    const session = this.session + 1;
    this.session = session;
    this.discard = false;
    this.chunks = [];
    this.stoppedDurationMs = null;
    this.publish({ phase: "requesting", elapsedMs: 0, error: null });

    try {
      const stream = await requestMicrophone(getUserMedia);
      if (this.disposed || this.session !== session || this.getSnapshot().phase !== "requesting") {
        stopStream(stream);
        return;
      }
      this.stream = stream;
      const preferredMime = preferredRecordingMimeType(mediaRecorder);
      const recorder = preferredMime
        ? new mediaRecorder(stream, { mimeType: preferredMime })
        : new mediaRecorder(stream);
      this.recorder = recorder;
      this.startedAt = this.now();

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onerror = (event: Event) => {
        const cause = "error" in event ? (event as Event & { error?: unknown }).error : event;
        this.discard = true;
        const error = mapRecorderError(cause);
        this.publish({
          ...this.snapshot,
          phase: "stopping",
          elapsedMs: Math.max(0, this.now() - this.startedAt),
          error,
        });
        this.onError?.(error);
        this.stopRecorder(recorder);
        this.releaseStream();
      };
      recorder.onstop = () => this.finalize(recorder);
      recorder.start(250);
      this.publish({ phase: "recording", elapsedMs: 0, error: null });
      this.startElapsedTimer();
    } catch (cause) {
      if (this.session !== session || this.disposed) return;
      if (this.recorder) {
        this.recorder.ondataavailable = null;
        this.recorder.onerror = null;
        this.recorder.onstop = null;
        this.recorder = null;
      }
      this.cleanupMedia();
      this.report(mapRecorderError(cause));
    }
  }

  stop(): void {
    if (this.disposed) return;
    if (this.snapshot.phase === "requesting") {
      this.session += 1;
      this.report({
        code: "interrupted",
        message: "麦克风权限确认后，请重新开始录音",
      });
      return;
    }
    if (this.snapshot.phase !== "recording" || !this.recorder) return;
    this.discard = false;
    this.stoppedDurationMs = Math.max(0, this.now() - this.startedAt);
    this.publish({
      ...this.snapshot,
      phase: "stopping",
      elapsedMs: this.stoppedDurationMs,
    });
    this.stopRecorder(this.recorder);
  }

  cancel(): void {
    if (this.snapshot.phase === "idle") return;
    if (this.snapshot.phase === "requesting") {
      this.session += 1;
      this.publish({ phase: "idle", elapsedMs: 0, error: null });
      return;
    }
    this.discard = true;
    if (this.recorder) {
      this.publish({
        ...this.snapshot,
        phase: "stopping",
        elapsedMs: Math.max(0, this.now() - this.startedAt),
      });
      this.stopRecorder(this.recorder);
      this.releaseStream();
    } else {
      this.cleanupMedia();
      this.publish({ phase: "idle", elapsedMs: 0, error: null });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session += 1;
    this.discard = true;
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* 已停止 */ }
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
    this.cleanupMedia();
    this.listeners.clear();
  }

  private stopRecorder(recorder: MediaRecorder): void {
    if (this.recorder !== recorder) return;
    if (recorder.state === "inactive") {
      this.finalize(recorder);
      return;
    }
    try {
      recorder.stop();
    } catch (cause) {
      this.discard = true;
      this.report(mapRecorderError(cause));
      this.finalize(recorder);
      return;
    }
    // 测试替身和个别浏览器会同步派发 stop；此时 finalize 已完成，不再挂 watchdog。
    if (this.recorder !== recorder) return;
    this.clearWatchdog();
    this.watchdogId = this.setTimeout(() => this.finalize(recorder), STOP_WATCHDOG_MS);
  }

  private finalize(recorder: MediaRecorder): void {
    if (this.recorder !== recorder) return;
    const durationMs = this.stoppedDurationMs ?? Math.max(0, this.now() - this.startedAt);
    const chunks = this.chunks;
    const discarded = this.discard;
    const existingError = this.snapshot.error;
    const mimeType = normalizeRecordingMimeType(recorder.mimeType || chunks[0]?.type || "audio/webm");
    this.recorder = null;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    this.cleanupMedia();

    if (this.disposed) return;
    if (discarded) {
      this.publish({ phase: "idle", elapsedMs: 0, error: existingError });
      return;
    }
    if (durationMs < this.minDurationMs) {
      this.report({ code: "too-short", message: "录音太短，请说完后再结束录音" });
      return;
    }
    const file = new File(chunks, `recording-${Date.now()}.${recordingFileExtension(mimeType)}`, {
      type: mimeType,
      lastModified: Date.now(),
    });
    if (file.size === 0) {
      this.report({ code: "empty-recording", message: "没有录到声音，请检查麦克风后重试" });
      return;
    }
    this.publish({ phase: "idle", elapsedMs: 0, error: null });
    this.onRecorded({ file, durationMs, mimeType });
  }

  private report(error: AudioRecorderError): void {
    this.publish({ phase: "idle", elapsedMs: 0, error });
    this.onError?.(error);
  }

  private startElapsedTimer(): void {
    this.clearElapsedTimer();
    this.intervalId = this.setInterval(() => {
      if (this.snapshot.phase !== "recording") return;
      this.publish({ ...this.snapshot, elapsedMs: Math.max(0, this.now() - this.startedAt) });
    }, 100);
  }

  private cleanupMedia(): void {
    this.clearElapsedTimer();
    this.clearWatchdog();
    this.releaseStream();
    this.chunks = [];
    this.startedAt = 0;
    this.stoppedDurationMs = null;
  }

  private releaseStream(): void {
    if (!this.stream) return;
    stopStream(this.stream);
    this.stream = null;
  }

  private clearElapsedTimer(): void {
    if (this.intervalId === null) return;
    (this.environment.clearInterval ?? globalThis.clearInterval)(this.intervalId);
    this.intervalId = null;
  }

  private clearWatchdog(): void {
    if (this.watchdogId === null) return;
    (this.environment.clearTimeout ?? globalThis.clearTimeout)(this.watchdogId);
    this.watchdogId = null;
  }

  private now(): number {
    return (this.environment.now ?? Date.now)();
  }

  private setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
    return (this.environment.setInterval ?? globalThis.setInterval)(callback, delay);
  }

  private setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    return (this.environment.setTimeout ?? globalThis.setTimeout)(callback, delay);
  }

  private publish(snapshot: RecorderSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

async function requestMicrophone(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
): Promise<MediaStream> {
  try {
    return await getUserMedia(AUDIO_CONSTRAINTS);
  } catch (cause) {
    const name = cause && typeof cause === "object" && "name" in cause
      ? String((cause as { name?: unknown }).name ?? "")
      : "";
    if (name !== "OverconstrainedError") throw cause;
    return getUserMedia({ audio: true, video: false });
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
