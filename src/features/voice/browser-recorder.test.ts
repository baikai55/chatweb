import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BrowserAudioRecorder,
  mapRecorderError,
  normalizeRecordingMimeType,
  preferredRecordingMimeType,
  recordingFileExtension,
  type AudioRecorderError,
  type RecordedAudio,
  type RecorderEnvironment,
} from "@/features/voice/browser-recorder";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supportedTypes = new Set(["audio/webm;codecs=opus"]);
  static payload = "recorded voice";
  static autoStopEvent = true;
  static throwOnStart = false;

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supportedTypes.has(type);
  }

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    if (FakeMediaRecorder.throwOnStart) throw new DOMException("encoder failed", "NotSupportedError");
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") throw new DOMException("already stopped", "InvalidStateError");
    this.state = "inactive";
    if (!FakeMediaRecorder.autoStopEvent) return;
    this.emitData(FakeMediaRecorder.payload);
    this.onstop?.();
  }

  emitData(payload: string): void {
    const data = new Blob([payload], { type: this.mimeType });
    this.ondataavailable?.({ data } as BlobEvent);
  }
}

describe("录音格式工具", () => {
  it("按浏览器支持顺序选择编码格式", () => {
    FakeMediaRecorder.supportedTypes = new Set(["audio/ogg;codecs=opus", "audio/webm"]);

    expect(preferredRecordingMimeType(FakeMediaRecorder as unknown as typeof MediaRecorder))
      .toBe("audio/ogg;codecs=opus");
  });

  it("规范化 MIME 并生成服务端可识别的扩展名", () => {
    expect(normalizeRecordingMimeType("audio/x-m4a; codecs=aac")).toBe("audio/mp4");
    expect(normalizeRecordingMimeType("application/ogg")).toBe("audio/ogg");
    expect(normalizeRecordingMimeType("application/octet-stream")).toBe("audio/webm");
    expect(recordingFileExtension("audio/mp4")).toBe("m4a");
    expect(recordingFileExtension("audio/ogg;codecs=opus")).toBe("ogg");
  });

  it("把浏览器设备错误映射成用户可处理的错误", () => {
    expect(mapRecorderError(new DOMException("denied", "NotAllowedError")).code).toBe("permission-denied");
    expect(mapRecorderError({ name: "NotFoundError" }).code).toBe("no-device");
    expect(mapRecorderError({ name: "NotReadableError" }).code).toBe("device-busy");
    expect(mapRecorderError({ name: "AbortError" }).code).toBe("interrupted");
  });
});

describe("BrowserAudioRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:00:00Z"));
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supportedTypes = new Set(["audio/webm;codecs=opus"]);
    FakeMediaRecorder.payload = "recorded voice";
    FakeMediaRecorder.autoStopEvent = true;
    FakeMediaRecorder.throwOnStart = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("录音完成后输出 File、时长，并释放媒体轨道", async () => {
    const { stream, stopTrack } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const onRecorded = vi.fn();
    let now = 1_000;
    const recorder = createRecorder({ getUserMedia, onRecorded, now: () => now });

    await recorder.start();
    expect(recorder.getSnapshot().phase).toBe("recording");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    now = 2_250;
    vi.advanceTimersByTime(100);
    expect(recorder.getSnapshot().elapsedMs).toBe(1_250);
    recorder.stop();

    expect(onRecorded).toHaveBeenCalledOnce();
    const result = onRecorded.mock.calls[0]?.[0];
    expect(result.durationMs).toBe(1_250);
    expect(result.mimeType).toBe("audio/webm");
    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toMatch(/^recording-\d+\.webm$/);
    expect(result.file.type).toBe("audio/webm");
    expect(await result.file.text()).toBe("recorded voice");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot()).toEqual({ phase: "idle", elapsedMs: 0, error: null });
  });

  it("高级音频约束不被设备接受时退回基础约束", async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce({ name: "OverconstrainedError" })
      .mockResolvedValueOnce(stream);
    const recorder = createRecorder({ getUserMedia });

    await recorder.start();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true, video: false });
    recorder.cancel();
  });

  it("等待权限时取消，并在迟到的媒体流到达后立即释放", async () => {
    const deferred = promiseWithResolvers<MediaStream>();
    const { stream, stopTrack } = fakeStream();
    const recorder = createRecorder({ getUserMedia: () => deferred.promise });

    const starting = recorder.start();
    expect(recorder.getSnapshot().phase).toBe("requesting");
    recorder.cancel();
    expect(recorder.getSnapshot()).toEqual({ phase: "idle", elapsedMs: 0, error: null });

    deferred.resolve(stream);
    await starting;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("按住模式在权限弹窗期间松开时给出可恢复提示", async () => {
    const deferred = promiseWithResolvers<MediaStream>();
    const { stream, stopTrack } = fakeStream();
    const onError = vi.fn();
    const recorder = createRecorder({ getUserMedia: () => deferred.promise, onError });

    const starting = recorder.start();
    recorder.stop();

    expect(recorder.getSnapshot().error?.code).toBe("interrupted");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "interrupted" }));
    deferred.resolve(stream);
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("拒绝过短和空录音", async () => {
    const tooShortError = vi.fn();
    let now = 0;
    const tooShort = createRecorder({ onError: tooShortError, now: () => now });
    await tooShort.start();
    now = 299;
    tooShort.stop();
    expect(tooShortError).toHaveBeenCalledWith(expect.objectContaining({ code: "too-short" }));

    FakeMediaRecorder.payload = "";
    const emptyError = vi.fn();
    let emptyNow = 0;
    const empty = createRecorder({ onError: emptyError, now: () => emptyNow });
    await empty.start();
    emptyNow = 1_000;
    empty.stop();
    expect(emptyError).toHaveBeenCalledWith(expect.objectContaining({ code: "empty-recording" }));
  });

  it("停止事件缺失时由 watchdog 完成收尾", async () => {
    const { stream, stopTrack } = fakeStream();
    const onRecorded = vi.fn();
    FakeMediaRecorder.autoStopEvent = false;
    let now = 0;
    const recorder = createRecorder({ getUserMedia: async () => stream, onRecorded, now: () => now });
    await recorder.start();
    FakeMediaRecorder.instances[0]?.emitData("watchdog audio");
    now = 800;

    recorder.stop();
    expect(recorder.getSnapshot().phase).toBe("stopping");
    now = 2_800;
    vi.advanceTimersByTime(2_000);

    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 800 }));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().phase).toBe("idle");
  });

  it("取消时不等待停止事件，立即释放麦克风轨道", async () => {
    const { stream, stopTrack } = fakeStream();
    const onRecorded = vi.fn();
    FakeMediaRecorder.autoStopEvent = false;
    const recorder = createRecorder({ getUserMedia: async () => stream, onRecorded });
    await recorder.start();

    recorder.cancel();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(recorder.getSnapshot().phase).toBe("stopping");
    expect(onRecorded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(recorder.getSnapshot()).toEqual({ phase: "idle", elapsedMs: 0, error: null });
  });

  it("编码器 start 失败后可再次开始，不保留旧实例", async () => {
    const onError = vi.fn();
    FakeMediaRecorder.throwOnStart = true;
    const recorder = createRecorder({ onError });

    await recorder.start();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "encoding-failed" }));
    expect(recorder.getSnapshot().phase).toBe("idle");

    FakeMediaRecorder.throwOnStart = false;
    await recorder.start();
    expect(recorder.getSnapshot().phase).toBe("recording");
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    recorder.cancel();
  });

  it("卸载时丢弃结果并停止轨道", async () => {
    const { stream, stopTrack } = fakeStream();
    const onRecorded = vi.fn();
    const recorder = createRecorder({ getUserMedia: async () => stream, onRecorded });
    await recorder.start();

    recorder.dispose();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("明确报告非安全上下文和权限拒绝", async () => {
    const insecureError = vi.fn();
    const insecure = createRecorder({ secureContext: false, onError: insecureError });
    await insecure.start();
    expect(insecureError).toHaveBeenCalledWith(expect.objectContaining({ code: "insecure-context" }));

    const deniedError = vi.fn();
    const denied = createRecorder({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      onError: deniedError,
    });
    await denied.start();
    expect(deniedError).toHaveBeenCalledWith(expect.objectContaining({ code: "permission-denied" }));
  });
});

function createRecorder({
  getUserMedia,
  onRecorded = vi.fn(),
  onError,
  now,
  secureContext = true,
}: {
  getUserMedia?: RecorderEnvironment["getUserMedia"];
  onRecorded?: (result: RecordedAudio) => void;
  onError?: (error: AudioRecorderError) => void;
  now?: () => number;
  secureContext?: boolean;
} = {}): BrowserAudioRecorder {
  return new BrowserAudioRecorder({
    minDurationMs: 300,
    onRecorded,
    onError,
    environment: {
      secureContext,
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      getUserMedia: getUserMedia ?? (async () => fakeStream().stream),
      now,
    },
  });
}

function fakeStream(): { stream: MediaStream; stopTrack: ReturnType<typeof vi.fn> } {
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  return { stream, stopTrack };
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
