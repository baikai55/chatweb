import { describe, expect, it } from "vitest";

import { MAX_GENERATIONS_PER_KIND, type GenerationRecord } from "@/features/history/generation-store";
import { mergeGenerationRecords } from "@/features/history/use-generation-history";

function record(id: string, createdAt: number, title = id): GenerationRecord {
  return {
    id,
    scope: "backend",
    kind: "voice",
    createdAt,
    model: "voice-model",
    title,
    assets: [],
  };
}

describe("mergeGenerationRecords", () => {
  it("保留异步加载期间刚生成的记录", () => {
    const current = record("new", 20);
    const loaded = record("old", 10);

    expect(mergeGenerationRecords([current], [loaded])).toEqual([current, loaded]);
  });

  it("同 id 时以内存中的记录为准", () => {
    const current = record("same", 20, "内存新版");
    // 故意让磁盘记录时间更新，确保实现依据来源优先级，而不是碰巧选时间较新的。
    const loaded = record("same", 30, "磁盘旧版");

    expect(mergeGenerationRecords([current], [loaded])).toEqual([current]);
  });

  it("内存列表只保留最新 50 条", () => {
    const records = Array.from(
      { length: MAX_GENERATIONS_PER_KIND + 5 },
      (_, index) => record(`record-${index}`, index),
    );

    const merged = mergeGenerationRecords([], records);

    expect(merged).toHaveLength(MAX_GENERATIONS_PER_KIND);
    expect(merged[0]?.createdAt).toBe(MAX_GENERATIONS_PER_KIND + 4);
    expect(merged.at(-1)?.createdAt).toBe(5);
  });
});
