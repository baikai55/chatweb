import { describe, expect, it, vi } from "vitest";

import {
  MAX_STT_AUDIO_BYTES,
  ensureSTTWebMDuration,
  prepareRecordedSTTAudioFile,
  validateSTTAudioFile,
  validateSTTAudioMetadata,
} from "@/features/voice/audio-file";

function audio(
  bytes: number[],
  overrides: Partial<{ name: string; type: string }> = {},
): File {
  return new File([new Uint8Array(bytes)], overrides.name ?? "sample.mp3", {
    type: overrides.type ?? "audio/mpeg",
  });
}

describe("validateSTTAudioFile", () => {
  it("接受内容与声明一致的常见音频容器", async () => {
    await expect(validateSTTAudioFile(audio([0x49, 0x44, 0x33, 0x04], { name: "sample.mp3" }))).resolves.toBe("");
    await expect(validateSTTAudioFile(audio(
      [0x4f, 0x67, 0x67, 0x53],
      { name: "recording.opus", type: "audio/ogg" },
    ))).resolves.toBe("");
    await expect(validateSTTAudioFile(audio(
      [0x1a, 0x45, 0xdf, 0xa3],
      { name: "recording", type: "audio/webm" },
    ))).resolves.toBe("");
  });

  it("File.type 缺失时按扩展名和文件头兜底", async () => {
    await expect(validateSTTAudioFile(audio(
      [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70],
      { name: "录音.M4A", type: "" },
    ))).resolves.toBe("");
  });

  it("拒绝空文件、超大文件和明显不是音频的文件", () => {
    expect(validateSTTAudioMetadata({ name: "empty.mp3", size: 0, type: "audio/mpeg" })).toContain("空");
    expect(validateSTTAudioMetadata({
      name: "large.mp3",
      size: MAX_STT_AUDIO_BYTES + 1,
      type: "audio/mpeg",
    })).toContain("100 MB");
    expect(validateSTTAudioMetadata({ name: "notes.txt", size: 10, type: "text/plain" })).toContain("只支持");
  });

  it("拒绝改名文件以及内容与 MIME 冲突的文件", async () => {
    await expect(validateSTTAudioFile(audio(
      [0x68, 0x65, 0x6c, 0x6c, 0x6f],
      { name: "renamed.mp3", type: "audio/mpeg" },
    ))).resolves.toContain("无法识别");
    await expect(validateSTTAudioFile(audio(
      [0x4f, 0x67, 0x67, 0x53],
      { name: "wrong.mp3", type: "audio/mpeg" },
    ))).resolves.toContain("扩展名不一致");
  });
});

describe("ensureSTTWebMDuration", () => {
  it("按默认 TimecodeScale 补入 Float64 Duration，并保留文件元数据", async () => {
    const source = webmFile({ timecodeScaleNs: null });
    const fixed = await ensureSTTWebMDuration(source, 1_250);

    expect(fixed).not.toBe(source);
    expect(fixed.name).toBe(source.name);
    expect(fixed.type).toBe(source.type);
    expect(fixed.lastModified).toBe(source.lastModified);
    const parsed = parseWebM(await fileBytes(fixed));
    expect(parsed.duration).toBe(1_250);
    expect(parsed.info.declaredSize).toBe(parsed.info.end - parsed.info.bodyStart);
    expect(parsed.segment.declaredSize).toBe(parsed.segment.end - parsed.segment.bodyStart);
  });

  it("按 Info/TimecodeScale 把毫秒换算成 Segment ticks", async () => {
    const source = webmFile({ timecodeScaleNs: 500_000 });
    const fixed = await ensureSTTWebMDuration(source, 1_250);

    expect(parseWebM(await fileBytes(fixed)).duration).toBe(2_500);
  });

  it("覆盖 MediaRecorder 写出的零值 Duration，不重复追加元素", async () => {
    const source = webmFile({ durationTicks: 0 });
    const fixed = await ensureSTTWebMDuration(source, 1_250);

    expect(fixed).not.toBe(source);
    expect(fixed.size).toBe(source.size);
    expect(parseWebM(await fileBytes(fixed)).duration).toBe(1_250);
  });

  it("Info 和 Segment 增长越过单字节 VINT 后会同步扩容 size", async () => {
    const source = webmFile({ paddingBytes: 107 });
    const before = parseWebM(await fileBytes(source));
    expect(before.info.sizeWidth).toBe(1);
    expect(before.segment.sizeWidth).toBe(1);

    const fixed = await ensureSTTWebMDuration(source, 900);
    const after = parseWebM(await fileBytes(fixed));
    expect(after.info.sizeWidth).toBe(2);
    expect(after.segment.sizeWidth).toBe(2);
    expect(after.info.declaredSize).toBe(after.info.end - after.info.bodyStart);
    expect(after.segment.declaredSize).toBe(after.segment.end - after.segment.bodyStart);
    expect(after.duration).toBe(900);
  });

  it("Segment 使用 unknown size 时保留原 size VINT", async () => {
    const source = webmFile({ unknownSegmentSize: true });
    const sourceBytes = await fileBytes(source);
    const before = parseWebM(sourceBytes);

    const fixed = await ensureSTTWebMDuration(source, 750);
    const fixedBytes = await fileBytes(fixed);
    const after = parseWebM(fixedBytes);
    expect(after.segment.unknownSize).toBe(true);
    expect(fixedBytes.slice(after.segment.sizeStart, after.segment.bodyStart)).toEqual(
      sourceBytes.slice(before.segment.sizeStart, before.segment.bodyStart),
    );
    expect(after.duration).toBe(750);
  });

  it("已有有效 Duration、非 WebM、无效参数和损坏 EBML 均返回原文件", async () => {
    const withDuration = webmFile({ durationTicks: 321 });
    const matroska = webmFile({ docType: "matroska" });
    const indexed = webmFile({ indexed: true });
    const mp3 = audio([0x49, 0x44, 0x33, 0x04]);
    const invalidDuration = webmFile({});
    const malformed = new File([toArrayBuffer(concat(
      element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], asciiBytes("webm"))),
      element([0x18, 0x53, 0x80, 0x67], element([0x15, 0x49, 0xa9, 0x66], [0x00])),
    ))], "broken.webm", { type: "audio/webm" });

    await expect(ensureSTTWebMDuration(withDuration, 1_000)).resolves.toBe(withDuration);
    await expect(ensureSTTWebMDuration(matroska, 1_000)).resolves.toBe(matroska);
    await expect(ensureSTTWebMDuration(indexed, 1_000)).resolves.toBe(indexed);
    await expect(ensureSTTWebMDuration(mp3, 1_000)).resolves.toBe(mp3);
    await expect(ensureSTTWebMDuration(invalidDuration, Number.NaN)).resolves.toBe(invalidDuration);
    await expect(ensureSTTWebMDuration(malformed, 1_000)).resolves.toBe(malformed);
  });
});

describe("prepareRecordedSTTAudioFile", () => {
  it("把浏览器 WebM 录音转成标准单声道 PCM WAV", async () => {
    const source = webmFile({ durationTicks: 0 });
    const decodeAudio = vi.fn(async () => ({
      numberOfChannels: 2,
      length: 2,
      sampleRate: 48_000,
      getChannelData: (channel: number) => channel === 0
        ? new Float32Array([-1, 0.5])
        : new Float32Array([1, 0.5]),
    }));

    const prepared = await prepareRecordedSTTAudioFile(source, 1_250, { decodeAudio });
    const bytes = await fileBytes(prepared);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(decodeAudio).toHaveBeenCalledOnce();
    expect(prepared.name).toBe("recording.wav");
    expect(prepared.type).toBe("audio/wav");
    expect(ascii(bytes.slice(0, 4))).toBe("RIFF");
    expect(ascii(bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_383);
  });

  it("设备无法解码 WebM 时退回 Duration 修复，非 WebM 不启动解码", async () => {
    const decodeAudio = vi.fn(async () => { throw new Error("unsupported codec"); });
    const webm = webmFile({ durationTicks: 0 });
    const fixedWebM = await prepareRecordedSTTAudioFile(webm, 900, { decodeAudio });
    expect(fixedWebM.type).toBe(webm.type);
    expect(parseWebM(await fileBytes(fixedWebM)).duration).toBe(900);

    const mp3 = audio([0x49, 0x44, 0x33, 0x04]);
    await expect(prepareRecordedSTTAudioFile(mp3, 900, { decodeAudio })).resolves.toBe(mp3);
    expect(decodeAudio).toHaveBeenCalledOnce();
  });

  it("准备过程支持取消，并跳过过长录音的移动端 WAV 转码", async () => {
    const source = webmFile({ durationTicks: 0 });
    const controller = new AbortController();
    controller.abort();
    const decodeAudio = vi.fn(async () => ({
      numberOfChannels: 1,
      length: 1,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([0]),
    }));

    await expect(prepareRecordedSTTAudioFile(source, 1_000, {
      decodeAudio,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(decodeAudio).not.toHaveBeenCalled();

    const fixedLongRecording = await prepareRecordedSTTAudioFile(source, 120_001, { decodeAudio });
    expect(parseWebM(await fileBytes(fixedLongRecording)).duration).toBe(120_001);
    expect(decodeAudio).not.toHaveBeenCalled();
  });
});

type TestEbmlElement = {
  id: number;
  sizeStart: number;
  sizeWidth: number;
  bodyStart: number;
  end: number;
  declaredSize: number | null;
  unknownSize: boolean;
};

function webmFile({
  docType = "webm",
  timecodeScaleNs = 1_000_000,
  durationTicks,
  paddingBytes = 0,
  unknownSegmentSize = false,
  indexed = false,
}: {
  docType?: string;
  timecodeScaleNs?: number | null;
  durationTicks?: number;
  paddingBytes?: number;
  unknownSegmentSize?: boolean;
  indexed?: boolean;
}): File {
  const ebml = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], asciiBytes(docType)));
  const infoParts: Uint8Array[] = [];
  if (timecodeScaleNs !== null) {
    infoParts.push(element([0x2a, 0xd7, 0xb1], unsignedBytes(timecodeScaleNs)));
  }
  if (paddingBytes > 0) infoParts.push(element([0xec], new Uint8Array(paddingBytes)));
  if (durationTicks !== undefined) {
    const duration = new Uint8Array(8);
    new DataView(duration.buffer).setFloat64(0, durationTicks, false);
    infoParts.push(element([0x44, 0x89], duration));
  }
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(...infoParts));
  const segmentBody = indexed
    ? concat(info, element([0x1c, 0x53, 0xbb, 0x6b], []))
    : info;
  const segment = unknownSegmentSize
    ? concat(new Uint8Array([0x18, 0x53, 0x80, 0x67]), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), segmentBody)
    : element([0x18, 0x53, 0x80, 0x67], segmentBody);
  return new File([toArrayBuffer(concat(ebml, segment))], "recording.webm", {
    type: "audio/webm;codecs=opus",
    lastModified: 123_456,
  });
}

function parseWebM(bytes: Uint8Array): {
  segment: TestEbmlElement;
  info: TestEbmlElement;
  duration: number | null;
} {
  const ebml = readTestElement(bytes, 0, bytes.length);
  const segment = readTestElement(bytes, ebml.end, bytes.length);
  const info = readTestElement(bytes, segment.bodyStart, segment.end);
  let duration: number | null = null;
  let cursor = info.bodyStart;
  while (cursor < info.end) {
    const child = readTestElement(bytes, cursor, info.end);
    if (child.id === 0x4489) {
      duration = new DataView(bytes.buffer, bytes.byteOffset + child.bodyStart, child.end - child.bodyStart)
        .getFloat64(0, false);
    }
    cursor = child.end;
  }
  return { segment, info, duration };
}

function readTestElement(bytes: Uint8Array, offset: number, limit: number): TestEbmlElement {
  const idWidth = vintWidth(bytes[offset]!);
  let id = 0;
  for (let index = 0; index < idWidth; index += 1) id = id * 0x100 + bytes[offset + index]!;
  const sizeStart = offset + idWidth;
  const sizeWidth = vintWidth(bytes[sizeStart]!);
  const marker = 1 << (8 - sizeWidth);
  let size = BigInt(bytes[sizeStart]! & (marker - 1));
  for (let index = 1; index < sizeWidth; index += 1) size = size * 0x100n + BigInt(bytes[sizeStart + index]!);
  const unknownSize = size === (1n << BigInt(sizeWidth * 7)) - 1n;
  const bodyStart = sizeStart + sizeWidth;
  const declaredSize = unknownSize ? null : Number(size);
  return {
    id,
    sizeStart,
    sizeWidth,
    bodyStart,
    end: declaredSize === null ? limit : bodyStart + declaredSize,
    declaredSize,
    unknownSize,
  };
}

function element(id: number[], body: Uint8Array | number[]): Uint8Array {
  const payload = body instanceof Uint8Array ? body : new Uint8Array(body);
  return concat(new Uint8Array(id), encodeTestSize(payload.length), payload);
}

function encodeTestSize(value: number): Uint8Array {
  let width = 1;
  while (value > 2 ** (width * 7) - 2) width += 1;
  let encoded = BigInt(value);
  const result = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  result[0] |= 1 << (8 - width);
  return result;
}

function unsignedBytes(value: number): Uint8Array {
  const result: number[] = [];
  let remaining = value;
  do {
    result.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  } while (remaining > 0);
  return new Uint8Array(result);
}

function asciiBytes(value: string): Uint8Array {
  return new Uint8Array(Array.from(value, (character) => character.charCodeAt(0)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function vintWidth(first: number): number {
  let marker = 0x80;
  let width = 1;
  while ((first & marker) === 0) {
    marker >>= 1;
    width += 1;
  }
  return width;
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
