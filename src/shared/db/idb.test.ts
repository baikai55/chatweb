import { describe, expect, it } from "vitest";

import { estimateStoredValueBytes } from "@/shared/db/idb";

describe("estimateStoredValueBytes", () => {
  it("按 UTF-8 统计文字，并包含嵌套 Blob 的真实大小", () => {
    const value = {
      text: "你好",
      assets: [{ blob: new Blob([new Uint8Array(1_024)]) }],
    };

    expect(estimateStoredValueBytes(value)).toBeGreaterThanOrEqual(1_030);
  });

  it("重复引用只统计一次", () => {
    const shared = { text: "same" };
    const once = estimateStoredValueBytes(shared);

    expect(estimateStoredValueBytes([shared, shared])).toBe(once);
  });
});
