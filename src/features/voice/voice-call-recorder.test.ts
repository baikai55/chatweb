import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  VoiceCallRecorder,
  calculateByteTimeDomainRms,
  createVoiceActivityState,
  updateVoiceActivity,
  type VoiceCallRecorderResult,
  type VoiceActivityState,
} from "@/features/voice/voice-call-recorder";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static autoStopEvent = true;
  static payload = "call audio";

  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }

  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number): void {
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
    this.ondataavailable?.({ data: new Blob([payload], { type: this.mimeType }) } as BlobEvent);
  }

  emitStop(): void {
    this.onstop?.();
  }
}

class FakeAnalyser {
  fftSize = 1024;
  level = 0;
  disconnect = vi.fn();

  getByteTimeDomainData(samples: Uint8Array<ArrayBuffer>): void {
    samples.fill(Math.max(0, Math.min(255, Math.round(128 + this.level * 128))));
  }
}

class FakeSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  state = "suspended";
  readonly analyser = new FakeAnalyser();
  readonly source = new FakeSource();
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => undefined);
  createAnalyser = vi.fn(() => this.analyser);
  createMediaStreamSource = vi.fn(() => this.source);
}

describe("纯 VAD 判定", () => {
  it("连续语音达到门槛并静音 900ms 后停止", () => {
    let state = createVoiceActivityState();
    let now = 0;
    ({ state } = sampleVad(state, 0.04, now += 50));
    ({ state } = sampleVad(state, 0.04, now += 50));
    let update = sampleVad(state, 0.04, now += 50);
    state = update.state;
    expect(state.speechDetected).toBe(true);

    ({ state } = sampleVad(state, 0.04, now += 50));
    ({ state } = sampleVad(state, 0.04, now += 50));
    for (let index = 0; index < 17; index += 1) {
      ({ state } = sampleVad(state, 0, now += 50));
    }
    update = sampleVad(state, 0, now += 50);

    expect(update.shouldStop).toBe(true);
  });

  it("忽略单次尖峰和不足最短人声的碰撞声", () => {
    let state = createVoiceActivityState();
    let now = 0;
    ({ state } = sampleVad(state, 0.08, now += 50));
    ({ state } = sampleVad(state, 0, now += 50));
    expect(state.speechDetected).toBe(false);

    ({ state } = sampleVad(state, 0.05, now += 50));
    ({ state } = sampleVad(state, 0.05, now += 50));
    ({ state } = sampleVad(state, 0.05, now += 50));
    expect(state.speechDetected).toBe(true);
    for (let index = 0; index < 18; index += 1) {
      ({ state } = sampleVad(state, 0, now += 50));
    }
    expect(state.speechDetected).toBe(false);
    expect(state.voicedMs).toBe(0);
  });

  it("RMS 计算兼容静音和固定振幅", () => {
    expect(calculateByteTimeDomainRms(new Uint8Array([128, 128]))).toBe(0);
    expect(calculateByteTimeDomainRms(new Uint8Array([160, 96]))).toBeCloseTo(0.25);
  });
});

describe("VoiceCallRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.autoStopEvent = true;
    FakeMediaRecorder.payload = "call audio";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("复用同一媒体流分析和录制，并在说完后自动产出文件", async () => {
    const resources = fakeResources();
    const results: VoiceCallRecorderResult[] = [];
    const recorder = createRecorder(resources, (result) => results.push(result));

    await recorder.start();
    expect(resources.getUserMedia).toHaveBeenCalledOnce();
    expect(resources.context.createMediaStreamSource).toHaveBeenCalledWith(resources.stream);
    expect(resources.context.source.connect).toHaveBeenCalledWith(resources.context.analyser);
    expect(recorder.getSnapshot().phase).toBe("listening");

    resources.context.analyser.level = 0.05;
    vi.advanceTimersByTime(300);
    expect(recorder.getSnapshot().speechDetected).toBe(true);
    resources.context.analyser.level = 0;
    vi.advanceTimersByTime(900);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "recorded", reason: "silence" });
    const result = results[0];
    if (result?.kind !== "recorded") throw new Error("没有录音结果");
    expect(result.recording.file.name).toMatch(/^recording-\d+\.webm$/);
    expect(result.recording.mimeType).toBe("audio/webm");
    expect(await result.recording.file.text()).toBe("call audio");
    expectReleased(resources);
    expect(resources.context.close).not.toHaveBeenCalled();

    await recorder.start();
    vi.advanceTimersByTime(500);
    recorder.forceStop();
    expect(results).toHaveLength(2);
    expect(resources.createAudioContext).toHaveBeenCalledOnce();
    expect(resources.context.resume).toHaveBeenCalledOnce();
    expect(resources.context.createAnalyser).toHaveBeenCalledTimes(2);
    expect(resources.context.createMediaStreamSource).toHaveBeenCalledTimes(2);

    recorder.dispose();
    expect(resources.context.close).toHaveBeenCalledOnce();
  });

  it("30 秒没有人声返回可区分结果并释放全部资源", async () => {
    const resources = fakeResources();
    const onResult = vi.fn();
    const recorder = createRecorder(resources, onResult);
    await recorder.start();

    vi.advanceTimersByTime(30_000);

    expect(onResult).toHaveBeenCalledWith({ kind: "no-speech", reason: "timeout" });
    expect(recorder.getSnapshot().phase).toBe("idle");
    expectReleased(resources);
  });

  it("forceStop 可提交尚未被 VAD 确认的录音，过短则按无语音返回", async () => {
    const first = fakeResources();
    const firstResult = vi.fn();
    const recorder = createRecorder(first, firstResult);
    await recorder.start();
    vi.advanceTimersByTime(500);
    recorder.forceStop();
    expect(firstResult).toHaveBeenCalledWith(expect.objectContaining({
      kind: "recorded",
      reason: "force-stop",
    }));

    const second = fakeResources();
    const secondResult = vi.fn();
    const shortRecorder = createRecorder(second, secondResult);
    await shortRecorder.start();
    vi.advanceTimersByTime(100);
    shortRecorder.forceStop();
    expect(secondResult).toHaveBeenCalledWith({ kind: "no-speech", reason: "force-stop" });
  });

  it("单轮到 60 秒时强制结束有效语音", async () => {
    const resources = fakeResources();
    const onResult = vi.fn();
    const recorder = createRecorder(resources, onResult);
    await recorder.start();
    resources.context.analyser.level = 0.05;

    vi.advanceTimersByTime(60_000);

    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      kind: "recorded",
      reason: "max-duration",
    }));
    expectReleased(resources);
  });

  it("等待权限时取消，迟到的流只释放且不会创建编码器", async () => {
    const deferred = promiseWithResolvers<MediaStream>();
    const resources = fakeResources();
    resources.getUserMedia.mockImplementation(() => deferred.promise);
    const onResult = vi.fn();
    const recorder = createRecorder(resources, onResult);

    const starting = recorder.start();
    await vi.waitFor(() => expect(resources.getUserMedia).toHaveBeenCalledOnce());
    recorder.cancel();
    deferred.resolve(resources.stream);
    await starting;

    expect(resources.stopTrack).toHaveBeenCalledOnce();
    expect(resources.context.close).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(onResult).not.toHaveBeenCalled();
    recorder.dispose();
    expect(resources.context.close).toHaveBeenCalledOnce();
  });

  it("停止事件缺失时由 watchdog 收尾，dispose 会压住迟到结果", async () => {
    FakeMediaRecorder.autoStopEvent = false;
    const resources = fakeResources();
    const onResult = vi.fn();
    const recorder = createRecorder(resources, onResult);
    await recorder.start();
    vi.advanceTimersByTime(500);
    FakeMediaRecorder.instances[0]?.emitData("buffered audio");
    recorder.forceStop();
    expect(recorder.getSnapshot().phase).toBe("stopping");
    vi.advanceTimersByTime(2_000);
    expect(onResult).toHaveBeenCalledOnce();

    const disposedResources = fakeResources();
    const disposedResult = vi.fn();
    const disposed = createRecorder(disposedResources, disposedResult);
    await disposed.start();
    vi.advanceTimersByTime(500);
    disposed.forceStop();
    disposed.dispose();
    FakeMediaRecorder.instances[1]?.emitStop();
    vi.advanceTimersByTime(2_000);
    expect(disposedResult).not.toHaveBeenCalled();
    expectReleased(disposedResources);
  });
});

function sampleVad(state: VoiceActivityState, rms: number, now: number) {
  return updateVoiceActivity(state, rms, now);
}

function createRecorder(
  resources: ReturnType<typeof fakeResources>,
  onResult: (result: VoiceCallRecorderResult) => void,
): VoiceCallRecorder {
  return new VoiceCallRecorder({
    onResult,
    environment: {
      secureContext: true,
      mediaRecorder: FakeMediaRecorder as unknown as typeof MediaRecorder,
      getUserMedia: resources.getUserMedia,
      createAudioContext: resources.createAudioContext,
    },
  });
}

function fakeResources() {
  const stopTrack = vi.fn();
  const track = {
    stop: stopTrack,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const context = new FakeAudioContext();
  const createAudioContext = vi.fn(() => context);
  const getUserMedia = vi.fn(async () => stream);
  return { context, createAudioContext, getUserMedia, stopTrack, stream, track };
}

function expectReleased(resources: ReturnType<typeof fakeResources>): void {
  expect(resources.stopTrack).toHaveBeenCalledOnce();
  expect(resources.context.source.disconnect).toHaveBeenCalledOnce();
  expect(resources.context.analyser.disconnect).toHaveBeenCalledOnce();
  expect(resources.track.removeEventListener).toHaveBeenCalledOnce();
}

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
