import { isRecord } from "@/transport/errors";

/**
 * 从任意响应结构里收集「正文」字符串。
 *
 * 走 chat/completions 生成图片或视频时，结果经常不在任何结构化字段里，而是
 * 拼在回复正文里的 `![](https://…)` 或一条裸链接。字段扫描完全看不到这种，
 * 所以图片和视频两边都要再扫一遍正文。
 *
 * 只扫这几个键下的字符串，免得把错误信息里的 URL 也当成结果。
 */
const TEXT_KEYS = new Set(["content", "text", "output_text", "markdown"]);

export function collectText(payload: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 10) return;
    if (typeof value === "string") {
      if (TEXT_KEYS.has(key) && value.trim()) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };

  visit(payload, "root", 0);
  return out;
}
