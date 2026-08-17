import { describe, expect, it } from "vitest";

import { appendTranscriptionToDraft } from "@/features/console/chat-voice-input";

describe("appendTranscriptionToDraft", () => {
  it("空草稿会得到去掉首尾空白的转写", () => {
    expect(appendTranscriptionToDraft("", "  你好  ")).toBe("你好");
  });

  it("中文相邻时直接追加", () => {
    expect(appendTranscriptionToDraft("已经输入", "继续说")).toBe("已经输入继续说");
  });

  it("英文和数字边界会补一个空格", () => {
    expect(appendTranscriptionToDraft("hello", "world")).toBe("hello world");
    expect(appendTranscriptionToDraft("version 2", "works")).toBe("version 2 works");
  });

  it("草稿已有尾随空白时不会重复补空格", () => {
    expect(appendTranscriptionToDraft("hello ", " world ")).toBe("hello world");
  });

  it("空白转写不会改动当前草稿", () => {
    expect(appendTranscriptionToDraft("用户正在编辑  ", " \n ")).toBe("用户正在编辑  ");
  });
});
