import {
  mapRecorderError,
  normalizeRecordingMimeType,
  preferredRecordingMimeType,
  recordingFileExtension,
  type AudioRecorderError,
  type RecordedAudio,
} from "@/features/voice/browser-recorder";

export type VoiceCallRecorderPhase = "idle" | "requesting" | "listening" | "stopping";

export type VoiceCallRecorderSnapshot = {
  phase: VoiceCallRecorderPhase;
  elapsedMs: number;
  speechDetected: boolean;
  error: AudioRecorderError | null;
};

export type VoiceCallRecordedReason = "silence" | "force-stop" | "max-duration";
export type VoiceCallNoSpeechReason = "timeout" | "force-stop" | "max-duration";

export type VoiceCallRecorderResult =
  | { kind: "recorded"; recording: RecordedAudio; reason: VoiceCallRecordedReason }
  | { kind: "no-speech"; reason: VoiceCallNoSpeechReason };

export type VoiceActivityConfig = {
  sampleIntervalMs: number;
  activationMs: number;
  silenceMs: number;
  minSpeechMs: number;
  initialNoiseFloor: number;
  minimumStartThreshold: number;
  minimumHoldThreshold: number;
  startNoiseMultiplier: number;
  holdNoiseMultiplier: number;
  noiseAlpha: number;
};

export const DEFAULT_VOICE_ACTIVITY_CONFIG: Readonly<VoiceActivityConfig> = {
  sampleIntervalMs: 50,
  activationMs: 150,
  silenceMs: 900,
  minSpeechMs: 250,
  initialNoiseFloor: 0.008,
  minimumStartThreshold: 0.018,
  minimumHoldThreshold: 0.012,
  startNoiseMultiplier: 3,
  holdNoiseMultiplier: 1.8,
  noiseAlpha: 0.05,
};

export type VoiceActivityState = {
  noiseFloor: number;
  candidateSpeechMs: number;
  voicedMs: number;
  speechDetected: boolean;
  lastVoiceAtMs: number | null;
  lastSampleAtMs: number | null;
};

export type VoiceActivityUpdate = {
  state: VoiceActivityState;
  shouldStop: boolean;
};

export function createVoiceActivityState(
  config: Pick<VoiceActivityConfig, "initialNoiseFloor"> = DEFAULT_VOICE_ACTIVITY_CONFIG,
): VoiceActivityState {
  return {
    noiseFloor: config.initialNoiseFloor,
    candidateSpeechMs: 0,
    voicedMs: 0,
    speechDetected: false,
    lastVoiceAtMs: null,
    lastSampleAtMs: null,
  };
}

/**
 * 用带迟滞的自适应 RMS 阈值识别人声段。状态是纯数据，方便用录制的电平序列回归。
 */
export function updateVoiceActivity(
  previous: VoiceActivityState,
  rmsInput: number,
  nowMs: number,
  config: VoiceActivityConfig = DEFAULT_VOICE_ACTIVITY_CONFIG,
): VoiceActivityUpdate {
  const rms = Number.isFinite(rmsInput) ? Math.min(1, Math.max(0, rmsInput)) : 0;
  const rawDelta = previous.lastSampleAtMs === null
    ? config.sampleIntervalMs
    : Math.max(0, nowMs - previous.lastSampleAtMs);
  // 页面卡顿不应凭一个样本补出数秒“连续语音”。
  const deltaMs = Math.min(rawDelta, config.sampleIntervalMs * 2);
  const startThreshold = Math.max(
    config.minimumStartThreshold,
    previous.noiseFloor * config.startNoiseMultiplier,
  );
  const holdThreshold = Math.max(
    config.minimumHoldThreshold,
    previous.noiseFloor * config.holdNoiseMultiplier,
  );

  let noiseFloor = previous.noiseFloor;
  let candidateSpeechMs = previous.candidateSpeechMs;
  let voicedMs = previous.voicedMs;
  let speechDetected = previous.speechDetected;
  let lastVoiceAtMs = previous.lastVoiceAtMs;

  if (!speechDetected) {
    if (rms >= startThreshold) {
      candidateSpeechMs += deltaMs;
      if (candidateSpeechMs >= config.activationMs) {
        speechDetected = true;
        voicedMs = candidateSpeechMs;
        lastVoiceAtMs = nowMs;
      }
    } else {
      candidateSpeechMs = 0;
      noiseFloor += (rms - noiseFloor) * config.noiseAlpha;
    }
  } else if (rms >= holdThreshold) {
    voicedMs += deltaMs;
    lastVoiceAtMs = nowMs;
  }

  let shouldStop = speechDetected
    && voicedMs >= config.minSpeechMs
    && lastVoiceAtMs !== null
    && nowMs - lastVoiceAtMs >= config.silenceMs;

  // 短促碰撞声达到启动阈值但没有构成有效语音时，退回等待状态。
  if (
    speechDetected
    && !shouldStop
    && voicedMs < config.minSpeechMs
    && lastVoiceAtMs !== null
    && nowMs - lastVoiceAtMs >= config.silenceMs
  ) {
    candidateSpeechMs = 0;
    voicedMs = 0;
    speechDetected = false;
    lastVoiceAtMs = null;
    shouldStop = false;
  }

  return {
    state: {
      noiseFloor,
      candidateSpeechMs,
      voicedMs,
      speechDetected,
      lastVoiceAtMs,
      lastSampleAtMs: nowMs,
    },
    shouldStop,
  };
}

export function calculateByteTimeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

type VoiceCallAnalyser = {
  fftSize: number;
  getByteTimeDomainData: (samples: Uint8Array<ArrayBuffer>) => void;
  disconnect: () => void;
};

type VoiceCallMediaSource = {
  connect: (destination: VoiceCallAnalyser) => unknown;
  disconnect: () => void;
};

type VoiceCallAudioContext = {
  state: string;
  resume: () => Promise<void>;
  close: () => Promise<void>;
  createAnalyser: () => VoiceCallAnalyser;
  createMediaStreamSource: (stream: MediaStream) => VoiceCallMediaSource;
};

export type VoiceCallRecorderEnvironment = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  mediaRecorder?: typeof MediaRecorder;
  createAudioContext?: () => VoiceCallAudioContext;
  secureContext?: boolean;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type VoiceCallRecorderOptions = {
  onResult: (result: VoiceCallRecorderResult) => void;
  onError?: (error: AudioRecorderError) => void;
  vad?: Partial<VoiceActivityConfig>;
  noSpeechTimeoutMs?: number;
  maxDurationMs?: number;
  minForceStopDurationMs?: number;
  environment?: VoiceCallRecorderEnvironment;
};

const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

const DEFAULT_NO_SPEECH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_MIN_FORCE_STOP_DURATION_MS = 300;
const STOP_WATCHDOG_MS = 2_000;

type PendingOutcome =
  | { kind: "recorded"; reason: VoiceCallRecordedReason }
  | { kind: "no-speech"; reason: VoiceCallNoSpeechReason }
  | { kind: "cancel" };

const IDLE_SNAPSHOT: VoiceCallRecorderSnapshot = {
  phase: "idle",
  elapsedMs: 0,
  speechDetected: false,
  error: null,
};

export class VoiceCallRecorder {
  private snapshot: VoiceCallRecorderSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly onResult: VoiceCallRecorderOptions["onResult"];
  private readonly onError?: VoiceCallRecorderOptions["onError"];
  private readonly vadConfig: VoiceActivityConfig;
  private readonly noSpeechTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly minForceStopDurationMs: number;
  private readonly environment: VoiceCallRecorderEnvironment;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioContext: VoiceCallAudioContext | null = null;
  private source: VoiceCallMediaSource | null = null;
  private analyser: VoiceCallAnalyser | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private chunks: Blob[] = [];
  private vadState: VoiceActivityState;
  private startedAt = 0;
  private stoppedDurationMs = 0;
  private pendingOutcome: PendingOutcome = { kind: "cancel" };
  private sequence = 0;
  private disposed = false;
  private pollId: ReturnType<typeof setInterval> | null = null;
  private watchdogId: ReturnType<typeof setTimeout> | null = null;
  private trackCleanup: Array<() => void> = [];

  constructor(options: VoiceCallRecorderOptions) {
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.vadConfig = { ...DEFAULT_VOICE_ACTIVITY_CONFIG, ...options.vad };
    this.noSpeechTimeoutMs = positiveNumber(options.noSpeechTimeoutMs, DEFAULT_NO_SPEECH_TIMEOUT_MS);
    this.maxDurationMs = positiveNumber(options.maxDurationMs, DEFAULT_MAX_DURATION_MS);
    this.minForceStopDurationMs = positiveNumber(
      options.minForceStopDurationMs,
      DEFAULT_MIN_FORCE_STOP_DURATION_MS,
    );
    this.environment = options.environment ?? {};
    this.vadState = createVoiceActivityState(this.vadConfig);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceCallRecorderSnapshot => this.snapshot;

  async start(): Promise<void> {
    if (this.disposed || this.snapshot.phase !== "idle") return;
    const mediaRecorder = this.environment.mediaRecorder ?? globalThis.MediaRecorder;
    const getUserMedia = this.environment.getUserMedia
      ?? (typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices) : undefined);
    const createAudioContext = this.environment.createAudioContext ?? defaultAudioContextFactory();
    const secureContext = this.environment.secureContext ?? globalThis.isSecureContext;

    if (secureContext === false) {
      this.report({ code: "insecure-context", message: "浏览器只允许在 HTTPS 或 localhost 使用麦克风" });
      return;
    }
    if (!mediaRecorder || !getUserMedia || !createAudioContext) {
      this.report({ code: "unsupported", message: "当前浏览器不支持通话录音或语音活动检测" });
      return;
    }

    const sequence = this.sequence + 1;
    this.sequence = sequence;
    this.chunks = [];
    this.vadState = createVoiceActivityState(this.vadConfig);
    this.pendingOutcome = { kind: "cancel" };
    this.stoppedDurationMs = 0;
    this.publish({ phase: "requesting", elapsedMs: 0, speechDetected: false, error: null });

    try {
      const context = this.audioContext ?? createAudioContext();
      this.audioContext ??= context;
      if (context.state !== "running") await context.resume();
      if (!this.isCurrent(sequence, "requesting")) return;

      const stream = await requestMicrophone(getUserMedia);
      if (!this.isCurrent(sequence, "requesting")) {
        stopStream(stream);
        return;
      }
      this.stream = stream;
      this.listenForTrackEnd(stream, sequence);

      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      this.analyser = analyser;
      this.source = source;
      this.samples = new Uint8Array(analyser.fftSize);

      const preferredMime = preferredRecordingMimeType(mediaRecorder);
      const recorder = preferredMime
        ? new mediaRecorder(stream, { mimeType: preferredMime })
        : new mediaRecorder(stream);
      this.recorder = recorder;
      this.startedAt = this.now();

      recorder.ondataavailable = (event: BlobEvent) => {
        if (this.sequence === sequence && event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onerror = (event: Event) => {
        const cause = "error" in event ? (event as Event & { error?: unknown }).error : event;
        this.fail(mapRecorderError(cause), sequence);
      };
      recorder.onstop = () => this.finalize(recorder, sequence);
      recorder.start(250);
      this.publish({ phase: "listening", elapsedMs: 0, speechDetected: false, error: null });
      this.startPolling(sequence);
    } catch (cause) {
      if (this.sequence !== sequence || this.disposed) return;
      this.fail(mapRecorderError(cause), sequence);
    }
  }

  /** 用户确认“说完了”。录音足够长时不要求 VAD 已经确认人声。 */
  forceStop(): void {
    if (this.disposed || this.snapshot.phase !== "listening") return;
    const elapsedMs = Math.max(0, this.now() - this.startedAt);
    if (elapsedMs < this.minForceStopDurationMs) {
      this.finish({ kind: "no-speech", reason: "force-stop" });
      return;
    }
    this.finish({ kind: "recorded", reason: "force-stop" });
  }

  cancel(): void {
    if (this.snapshot.phase === "idle") return;
    this.sequence += 1;
    this.pendingOutcome = { kind: "cancel" };
    const recorder = this.recorder;
    this.detachRecorder(recorder);
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* 已停止 */ }
    }
    this.cleanupResources();
    if (!this.disposed) this.publish(IDLE_SNAPSHOT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence += 1;
    this.pendingOutcome = { kind: "cancel" };
    const recorder = this.recorder;
    this.detachRecorder(recorder);
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* 已停止 */ }
    }
    this.cleanupResources();
    this.closeAudioContext();
    this.listeners.clear();
  }

  private startPolling(sequence: number): void {
    this.clearPoll();
    this.pollId = this.setInterval(() => {
      if (!this.isCurrent(sequence, "listening") || !this.analyser || !this.samples) return;
      const now = this.now();
      const elapsedMs = Math.max(0, now - this.startedAt);
      this.analyser.getByteTimeDomainData(this.samples);
      const update = updateVoiceActivity(
        this.vadState,
        calculateByteTimeDomainRms(this.samples),
        elapsedMs,
        this.vadConfig,
      );
      this.vadState = update.state;
      this.publish({
        phase: "listening",
        elapsedMs,
        speechDetected: update.state.speechDetected,
        error: null,
      });

      if (update.shouldStop) {
        this.finish({ kind: "recorded", reason: "silence" });
      } else if (elapsedMs >= this.maxDurationMs) {
        this.finish(update.state.speechDetected && update.state.voicedMs >= this.vadConfig.minSpeechMs
          ? { kind: "recorded", reason: "max-duration" }
          : { kind: "no-speech", reason: "max-duration" });
      } else if (elapsedMs >= this.noSpeechTimeoutMs && !update.state.speechDetected) {
        this.finish({ kind: "no-speech", reason: "timeout" });
      }
    }, this.vadConfig.sampleIntervalMs);
  }

  private finish(outcome: Exclude<PendingOutcome, { kind: "cancel" }>): void {
    const recorder = this.recorder;
    if (!recorder || this.snapshot.phase !== "listening") return;
    this.pendingOutcome = outcome;
    this.stoppedDurationMs = Math.max(0, this.now() - this.startedAt);
    this.publish({
      ...this.snapshot,
      phase: "stopping",
      elapsedMs: this.stoppedDurationMs,
    });
    this.clearPoll();
    this.disconnectAnalysis();

    if (recorder.state === "inactive") {
      this.finalize(recorder, this.sequence);
      return;
    }
    try {
      recorder.stop();
    } catch (cause) {
      this.fail(mapRecorderError(cause), this.sequence);
      return;
    }
    // 个别测试替身和浏览器同步派发 stop，此时 finalize 已经完成。
    if (this.recorder !== recorder) return;
    const sequence = this.sequence;
    this.clearWatchdog();
    this.watchdogId = this.setTimeout(() => this.finalize(recorder, sequence), STOP_WATCHDOG_MS);
  }

  private finalize(recorder: MediaRecorder, sequence: number): void {
    if (this.recorder !== recorder || this.sequence !== sequence) return;
    const outcome = this.pendingOutcome;
    const chunks = this.chunks;
    const durationMs = this.stoppedDurationMs || Math.max(0, this.now() - this.startedAt);
    const mimeType = normalizeRecordingMimeType(recorder.mimeType || chunks[0]?.type || "audio/webm");
    this.detachRecorder(recorder);
    this.cleanupResources();
    if (this.disposed || outcome.kind === "cancel") return;

    this.publish(IDLE_SNAPSHOT);
    if (outcome.kind === "no-speech") {
      this.onResult(outcome);
      return;
    }

    const timestamp = Math.floor(this.now());
    const file = new File(chunks, `recording-${timestamp}.${recordingFileExtension(mimeType)}`, {
      type: mimeType,
      lastModified: timestamp,
    });
    if (file.size === 0) {
      this.report({ code: "empty-recording", message: "没有录到声音，请检查麦克风后重试" });
      return;
    }
    this.onResult({
      kind: "recorded",
      reason: outcome.reason,
      recording: { file, durationMs, mimeType },
    });
  }

  private fail(error: AudioRecorderError, sequence: number): void {
    if (this.sequence !== sequence || this.disposed) return;
    const recorder = this.recorder;
    this.detachRecorder(recorder);
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* 编码器已经失败 */ }
    }
    this.cleanupResources();
    this.report(error);
  }

  private listenForTrackEnd(stream: MediaStream, sequence: number): void {
    for (const track of stream.getTracks()) {
      if (typeof track.addEventListener !== "function") continue;
      const onEnded = () => this.fail({
        code: "interrupted",
        message: "麦克风被系统中断，请重新开始通话",
      }, sequence);
      track.addEventListener("ended", onEnded);
      this.trackCleanup.push(() => track.removeEventListener("ended", onEnded));
    }
  }

  private detachRecorder(recorder: MediaRecorder | null): void {
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (this.recorder === recorder) this.recorder = null;
  }

  private disconnectAnalysis(): void {
    this.clearPoll();
    try { this.source?.disconnect(); } catch { /* 已断开 */ }
    try { this.analyser?.disconnect(); } catch { /* 已断开 */ }
    this.source = null;
    this.analyser = null;
    this.samples = null;
  }

  private cleanupResources(): void {
    this.clearWatchdog();
    this.disconnectAnalysis();
    for (const cleanup of this.trackCleanup.splice(0)) cleanup();
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
    this.stoppedDurationMs = 0;
    this.pendingOutcome = { kind: "cancel" };
  }

  private closeAudioContext(): void {
    const context = this.audioContext;
    this.audioContext = null;
    if (context) void context.close().catch(() => undefined);
  }

  private report(error: AudioRecorderError): void {
    this.publish({ ...IDLE_SNAPSHOT, error });
    this.onError?.(error);
  }

  private isCurrent(sequence: number, phase: VoiceCallRecorderPhase): boolean {
    return !this.disposed && this.sequence === sequence && this.snapshot.phase === phase;
  }

  private clearPoll(): void {
    if (this.pollId === null) return;
    (this.environment.clearInterval ?? globalThis.clearInterval)(this.pollId);
    this.pollId = null;
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

  private publish(snapshot: VoiceCallRecorderSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function defaultAudioContextFactory(): (() => VoiceCallAudioContext) | undefined {
  const host = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextConstructor = host.AudioContext ?? host.webkitAudioContext;
  if (!AudioContextConstructor) return undefined;
  return () => new AudioContextConstructor() as unknown as VoiceCallAudioContext;
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

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
