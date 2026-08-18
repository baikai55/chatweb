/**
 * 语音转写的浏览器侧安全边界。
 *
 * 上游实际支持多大的文件仍由上游决定；这里的 100 MB 只负责挡住误选的超大文件，
 * 避免浏览器直接把它装进 FormData 后长期占用内存。这个值与 Worker 默认上传上限一致。
 */
export const MAX_STT_AUDIO_BYTES = 100 * 1024 * 1024;

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "wave",
  "webm",
]);

type AudioContainer = "aac" | "flac" | "mp3" | "mp4" | "ogg" | "wav" | "webm";

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const DURATION_ID = 0x4489;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DOC_TYPE_ID = 0x4282;
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const SEEK_HEAD_ID = 0x114d9b74;
const CUES_ID = 0x1c53bb6b;
const CLUSTER_ID = 0x1f43b675;

const EXPECTED_BY_EXTENSION: Record<string, AudioContainer[]> = {
  aac: ["aac"],
  flac: ["flac"],
  m4a: ["mp4"],
  mp3: ["mp3"],
  ogg: ["ogg"],
  opus: ["ogg"],
  wav: ["wav"],
  wave: ["wav"],
  webm: ["webm"],
};

const EXPECTED_BY_CONTENT_TYPE: Record<string, AudioContainer[]> = {
  "application/ogg": ["ogg"],
  "audio/aac": ["aac"],
  "audio/flac": ["flac"],
  "audio/m4a": ["mp4"],
  "audio/mp4": ["mp4"],
  "audio/mpeg": ["mp3"],
  "audio/ogg": ["ogg"],
  "audio/opus": ["ogg"],
  "audio/wav": ["wav"],
  "audio/wave": ["wav"],
  "audio/webm": ["webm"],
  "audio/x-flac": ["flac"],
  "audio/x-m4a": ["mp4"],
  "audio/x-wav": ["wav"],
  "video/webm": ["webm"],
};

export function validateSTTAudioMetadata(file: Pick<File, "name" | "size" | "type">): string {
  if (file.size <= 0) return "音频文件是空的";
  if (file.size > MAX_STT_AUDIO_BYTES) return "音频文件不能超过 100 MB";

  const contentType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = file.name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const knownExtension = AUDIO_EXTENSIONS.has(extension);
  const knownContentType = contentType.startsWith("audio/")
    || contentType === "application/ogg"
    || contentType === "video/webm";

  // Windows 和部分移动浏览器可能不给 File.type，因此扩展名也要作为兜底。
  if (!knownContentType && !knownExtension) {
    return "只支持 MP3、WAV、M4A、OGG、OPUS、AAC、FLAC 或 WebM 音频";
  }
  return "";
}

/**
 * 除了 MIME/扩展名，再读很小一段文件头，挡住把文本或其它文件改名成音频的情况。
 * 不解码整段音频，也不会把用户文件上传到任何地方。
 */
export async function validateSTTAudioFile(file: File): Promise<string> {
  const metadataError = validateSTTAudioMetadata(file);
  if (metadataError) return metadataError;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  } catch {
    return "读取音频文件失败，请重新选择";
  }
  const detected = detectAudioContainer(bytes);
  if (!detected) return "无法识别音频文件内容，请确认文件没有损坏或改名";

  const extension = file.name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const contentType = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const expectedByExtension = EXPECTED_BY_EXTENSION[extension];
  if (expectedByExtension && !expectedByExtension.includes(detected)) {
    return "音频文件内容与扩展名不一致";
  }
  const expectedByContentType = EXPECTED_BY_CONTENT_TYPE[contentType];
  if (expectedByContentType && !expectedByContentType.includes(detected)) {
    return "音频文件内容与类型声明不一致";
  }
  return "";
}

/**
 * 为浏览器录出的 WebM 补上 Info/Duration。
 *
 * Chrome 的 MediaRecorder 有时会输出没有 Duration 的 WebM。部分 STT 服务会
 * 因此拒绝文件，或把时长当成 0。这里只改结构完整、明确没有 Duration 的
 * WebM；无法安全解析时返回原 File，不影响其它格式的上传。
 */
export async function ensureSTTWebMDuration(file: File, durationMs: number): Promise<File> {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || file.size > MAX_STT_AUDIO_BYTES) return file;

  try {
    const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (detectAudioContainer(header) !== "webm") return file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = locateWebMInfo(bytes);
    if (!parsed) return file;

    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88]);
    const durationTicks = durationMs * 1_000_000 / parsed.timecodeScaleNs;
    if (!Number.isFinite(durationTicks) || durationTicks <= 0) return file;
    new DataView(duration.buffer).setFloat64(3, durationTicks, false);

    const nextInfoBody = concatBytes(bytes.slice(parsed.info.bodyStart, parsed.info.end), duration);
    const nextInfo = concatBytes(
      bytes.slice(parsed.info.idStart, parsed.info.sizeStart),
      encodeEbmlSize(nextInfoBody.length, parsed.info.sizeWidth),
      nextInfoBody,
    );
    const segmentBody = concatBytes(
      bytes.slice(parsed.segment.bodyStart, parsed.info.idStart),
      nextInfo,
      bytes.slice(parsed.info.end, parsed.segment.end),
    );
    const nextSegment = concatBytes(
      bytes.slice(parsed.segment.idStart, parsed.segment.sizeStart),
      parsed.segment.unknownSize
        ? bytes.slice(parsed.segment.sizeStart, parsed.segment.bodyStart)
        : encodeEbmlSize(segmentBody.length, parsed.segment.sizeWidth),
      segmentBody,
    );
    const nextBytes = concatBytes(
      bytes.slice(0, parsed.segment.idStart),
      nextSegment,
      bytes.slice(parsed.segment.end),
    );

    return new File([copyToArrayBuffer(nextBytes)], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}

type EbmlElement = {
  id: number;
  idStart: number;
  sizeStart: number;
  bodyStart: number;
  end: number;
  sizeWidth: number;
  unknownSize: boolean;
};

type WebMInfoLocation = {
  segment: EbmlElement;
  info: EbmlElement;
  timecodeScaleNs: number;
};

function locateWebMInfo(bytes: Uint8Array): WebMInfoLocation | null {
  const ebml = readEbmlElement(bytes, 0, bytes.length);
  if (!ebml || ebml.id !== EBML_ID || ebml.unknownSize) return null;

  // Matroska files use the same EBML and Segment IDs, so the signature alone
  // is not enough to decide whether it is safe to apply the WebM workaround.
  const docType = readDocType(bytes, ebml);
  if (docType !== "webm") return null;

  let cursor = ebml.end;
  let segment: EbmlElement | null = null;
  while (cursor < bytes.length) {
    const element = readEbmlElement(bytes, cursor, bytes.length);
    if (!element) return null;
    if (element.id === SEGMENT_ID) {
      segment = element;
      break;
    }
    if (element.unknownSize) return null;
    cursor = element.end;
  }
  if (!segment) return null;

  let info: EbmlElement | null = null;
  cursor = segment.bodyStart;
  while (cursor < segment.end) {
    const element = readEbmlElement(bytes, cursor, segment.end);
    if (!element) return null;
    // 插入字节会使已有的 Segment-relative 索引失效；流式 MediaRecorder
    // 通常不生成这些元素，遇到索引文件则保守地保持原样。
    if (element.id === SEEK_HEAD_ID || element.id === CUES_ID) return null;
    if (element.id === INFO_ID) {
      if (element.unknownSize || info) return null;
      info = element;
    }
    if (element.unknownSize) {
      if (element.id === CLUSTER_ID && info) break;
      return null;
    }
    cursor = element.end;
  }
  if (!info) return null;
  const infoMetadata = readInfoMetadata(bytes, info);
  if (!infoMetadata || infoMetadata.hasDuration) return null;
  return { segment, info, timecodeScaleNs: infoMetadata.timecodeScaleNs };
}

function readDocType(bytes: Uint8Array, ebml: EbmlElement): string | null | undefined {
  let cursor = ebml.bodyStart;
  while (cursor < ebml.end) {
    const element = readEbmlElement(bytes, cursor, ebml.end);
    if (!element) return undefined;
    if (element.id === DOC_TYPE_ID) {
      const raw = bytes.slice(element.bodyStart, element.end);
      if (raw.length > 32) return undefined;
      return String.fromCharCode(...raw).replace(/\0+$/u, "").toLowerCase();
    }
    if (element.unknownSize) return undefined;
    cursor = element.end;
  }
  return null;
}

function readInfoMetadata(
  bytes: Uint8Array,
  info: EbmlElement,
): { hasDuration: boolean; timecodeScaleNs: number } | null {
  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;
  let cursor = info.bodyStart;
  while (cursor < info.end) {
    const element = readEbmlElement(bytes, cursor, info.end);
    if (!element) return null;
    if (element.id === DURATION_ID) return { hasDuration: true, timecodeScaleNs };
    if (element.id === TIMECODE_SCALE_ID) {
      const value = readEbmlUnsigned(bytes, element.bodyStart, element.end);
      if (value === null || value <= 0) return null;
      timecodeScaleNs = value;
    }
    if (element.unknownSize) return null;
    cursor = element.end;
  }
  return { hasDuration: false, timecodeScaleNs };
}

function readEbmlUnsigned(bytes: Uint8Array, start: number, end: number): number | null {
  const width = end - start;
  if (width < 1 || width > 8) return null;
  let value = 0n;
  for (let offset = start; offset < end; offset += 1) value = value * 0x100n + BigInt(bytes[offset]!);
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : null;
}

function readEbmlElement(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  const id = readEbmlId(bytes, offset, limit);
  if (!id) return null;
  const size = readEbmlSize(bytes, id.next, limit);
  if (!size) return null;
  const bodyStart = id.next + size.width;
  const end = size.value === null ? limit : bodyStart + size.value;
  if (end < bodyStart || end > limit) return null;
  return {
    id: id.value,
    idStart: offset,
    sizeStart: id.next,
    bodyStart,
    end,
    sizeWidth: size.width,
    unknownSize: size.value === null,
  };
}

function readEbmlId(bytes: Uint8Array, offset: number, limit: number): { value: number; next: number } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  let marker = 0x80;
  let width = 1;
  while ((first & marker) === 0 && width <= 4) {
    marker >>= 1;
    width += 1;
  }
  if (width > 4 || offset + width > limit) return null;
  let value = first;
  for (let index = 1; index < width; index += 1) value = value * 0x100 + bytes[offset + index]!;
  return { value, next: offset + width };
}

function readEbmlSize(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): { width: number; value: number | null } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  let marker = 0x80;
  let width = 1;
  while ((first & marker) === 0 && width <= 8) {
    marker >>= 1;
    width += 1;
  }
  if (width > 8 || offset + width > limit) return null;
  let value = BigInt(first & (marker - 1));
  for (let index = 1; index < width; index += 1) value = value * 0x100n + BigInt(bytes[offset + index]!);
  const unknown = value === (1n << BigInt(width * 7)) - 1n;
  if (unknown) return { width, value: null };
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) return null;
  return { width, value: numberValue };
}

function encodeEbmlSize(value: number, preferredWidth: number): Uint8Array {
  const safeValue = BigInt(Math.max(0, Math.floor(value)));
  let width = Math.min(8, Math.max(1, preferredWidth));
  while (width < 8 && safeValue > (1n << BigInt(width * 7)) - 2n) width += 1;
  if (safeValue > (1n << 56n) - 2n) throw new RangeError("EBML element is too large");

  let encoded = safeValue;
  const result = new Uint8Array(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  result[0] |= 1 << (8 - width);
  return result;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function detectAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (ascii(bytes, 0, 4) === "RIFF" || ascii(bytes, 0, 4) === "RF64") {
    if (ascii(bytes, 8, 4) === "WAVE") return "wav";
  }
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(bytes, 4, 4) === "ftyp") return "mp4";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (ascii(bytes, 0, 4) === "ADIF") return "aac";

  const first = bytes[0];
  const second = bytes[1];
  if (first === 0xff && second !== undefined) {
    // ADTS AAC 的 layer 位恒为 00；MPEG Audio 的 layer 位不能为 00。
    if ((second & 0xf6) === 0xf0) return "aac";
    if ((second & 0xe0) === 0xe0 && (second & 0x06) !== 0) return "mp3";
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
