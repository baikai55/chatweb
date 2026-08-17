import { describe, expect, it } from "vitest";

import { formatRecordingElapsed } from "@/features/voice/audio-recorder-button";

describe("formatRecordingElapsed", () => {
  it("显示稳定的分秒计时", () => {
    expect(formatRecordingElapsed(-1)).toBe("0:00");
    expect(formatRecordingElapsed(999)).toBe("0:00");
    expect(formatRecordingElapsed(1_000)).toBe("0:01");
    expect(formatRecordingElapsed(65_999)).toBe("1:05");
  });
});
