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
