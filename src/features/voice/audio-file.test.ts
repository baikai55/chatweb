import { describe, expect, it } from "vitest";

import {
  MAX_STT_AUDIO_BYTES,
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
