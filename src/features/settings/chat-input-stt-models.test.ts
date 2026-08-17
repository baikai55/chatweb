import { describe, expect, it } from "vitest";

import type { CatalogModel } from "@/backends/model-catalog";
import { listChatInputSTTModels } from "@/features/settings/chat-input-stt-models";

function model(id: string, kind: CatalogModel["kind"], saved: boolean): CatalogModel {
  return {
    id,
    kind,
    saved,
    ownedBy: "test",
    overridden: false,
    reasoning: false,
    vendor: "test",
  };
}

describe("listChatInputSTTModels", () => {
  it("只保留已保存且归类为语音转写的模型，并维持目录顺序", () => {
    const result = listChatInputSTTModels([
      model("whisper-large-v3", "stt", true),
      model("gpt-4.1", "chat", true),
      model("unused-stt", "stt", false),
      model("custom-asr", "stt", true),
    ]);

    expect(result.map((item) => item.id)).toEqual(["whisper-large-v3", "custom-asr"]);
  });

  it("没有合格模型时返回空列表", () => {
    expect(listChatInputSTTModels([
      model("gpt-4.1", "chat", true),
      model("whisper", "stt", false),
    ])).toEqual([]);
  });
});
