import { describe, expect, it } from "vitest";

import { CAPABILITIES } from "@/backends/types";
import { toggleCapabilitySelection } from "@/features/settings/capability-selection";

describe("toggleCapabilitySelection", () => {
  it("空列表代表全部开启，首次点击会真正关闭目标能力", () => {
    const result = toggleCapabilitySelection([], "tts");

    expect(result).toEqual(CAPABILITIES.filter((item) => item !== "tts"));
    expect(result).not.toContain("tts");
  });

  it("可以重新开启已关闭的能力", () => {
    const current = CAPABILITIES.filter((item) => item !== "stt");
    expect(toggleCapabilitySelection(current, "stt")).toEqual([...current, "stt"]);
  });

  it("至少保留一个面板", () => {
    const current = ["chat"] as Array<"chat">;
    expect(toggleCapabilitySelection(current, "chat")).toBe(current);
  });
});
