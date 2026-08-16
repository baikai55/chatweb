import { STORE_GENERATIONS, idbClear, idbDelete, idbGetByPrefix, idbPut } from "@/shared/db/idb";

/**
 * 生图 / 视频 / 语音的产物记录。
 *
 * 聊天早就有历史了，这三个面板一直是「刷新即失」—— 生成一张图要一两分钟，
 * 手一抖刷新就没了，很不合理。所以按跟会话同一套路存 IndexedDB：
 * 一条记录一行，`scope` 是后端 id，换后端不串。
 *
 * 存 URL 还是存字节，按来源分：
 *   - 图片、视频：上游给的是 http(s) 或 data: URL，都是字符串，直接存
 *     （远程 URL 可能过期，这是它本身的性质，存字节也救不了已经过期的链接）
 *   - 语音合成：只有二进制响应，`blob:` URL 一刷新就失效，**必须存字节**，
 *     打开这条记录时再重新造对象 URL
 */

export const GENERATION_KINDS = ["image", "video", "voice"] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

export type GenerationAsset = {
  /** 远程 URL 或 data: URL，可直接用 */
  url?: string;
  /** 只有语音会用：原始字节，读出来后现造对象 URL */
  blob?: Blob;
  contentType?: string;
  /** 图片的 revised_prompt 之类 */
  note?: string;
};

export type GenerationRecord = {
  id: string;
  /** 所属后端 id。复合索引 [scope, kind, createdAt] 的第一段。 */
  scope: string;
  kind: GenerationKind;
  createdAt: number;
  model: string;
  /** 侧栏里显示的一行字：提示词，或语音转写的文件名 */
  title: string;
  /** 纯文本结果，目前只有语音转写用 */
  text?: string;
  assets: GenerationAsset[];
  /** 点回一条记录时用来复原面板上的参数。形状随面板而定，读的时候要防着缺字段。 */
  params?: Record<string, unknown>;
};

/** 每个后端每个面板留多少条。存的是二进制，但生图一条能有四张，别无上限。 */
const MAX_PER_KIND = 50;

export function createGenerationId(): string {
  return `g_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * 把一个可显示 URL 收成一条待存资产。
 *
 * `data:` 和 `blob:` 一律转成 Blob 存：IndexedDB 存二进制比存 base64 文本省约
 * 四分之一，而 `blob:` URL 一刷新就失效，不转就等于没存。远程 URL 原样存字符串
 * —— 远程链接可能过期，但那是链接本身的性质，把字节抓下来也救不了已经过期的。
 */
export async function toAsset(url: string, note?: string): Promise<GenerationAsset> {
  if (/^https?:/i.test(url)) return { url, note };
  try {
    const blob = await fetch(url).then((response) => response.blob());
    return { blob, contentType: blob.type || undefined, note };
  } catch {
    // 转不成就退回存 URL，至少不丢这条记录
    return { url, note };
  }
}

/** 侧栏用的一行字：太长的提示词截断。 */
export function deriveGenerationTitle(prompt: string): string {
  const text = prompt.trim().replaceAll(/\s+/g, " ");
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 按创建时间倒序。 */
export async function loadGenerations(scope: string, kind: GenerationKind): Promise<GenerationRecord[]> {
  try {
    const rows = await idbGetByPrefix<GenerationRecord>(STORE_GENERATIONS, "byScopeKind", [scope, kind]);
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    // 隐私模式或数据库打不开。降级成"没有历史"，不影响生成。
    return [];
  }
}

export async function saveGeneration(record: GenerationRecord): Promise<void> {
  try {
    await idbPut(STORE_GENERATIONS, record);
  } catch {
    // 写失败不该打断面板，结果还在眼前
  }
}

export async function deleteGeneration(id: string): Promise<void> {
  try {
    await idbDelete(STORE_GENERATIONS, id);
  } catch {
    // 忽略
  }
}

/** 超出上限时清理最旧的。保存后异步调一下即可，不用等。 */
export async function pruneGenerations(scope: string, kind: GenerationKind): Promise<void> {
  try {
    const rows = await idbGetByPrefix<GenerationRecord>(STORE_GENERATIONS, "byScopeKind", [scope, kind]);
    if (rows.length <= MAX_PER_KIND) return;
    const excess = rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, rows.length - MAX_PER_KIND);
    await Promise.all(excess.map((record) => idbDelete(STORE_GENERATIONS, record.id)));
  } catch {
    // 忽略
  }
}

export async function clearAllGenerations(): Promise<void> {
  await idbClear(STORE_GENERATIONS);
}

/**
 * 把一条记录变成可以直接渲染的样子：blob 现造对象 URL。
 *
 * 造出来的 URL 必须由调用方 revoke —— 返回值里带上要释放的清单，
 * 别让调用方自己去猜哪些是临时的。
 */
export function hydrateAssets(record: GenerationRecord): {
  urls: Array<{ url: string; contentType?: string; note?: string }>;
  release: () => void;
} {
  const created: string[] = [];
  const urls = record.assets.flatMap((asset) => {
    if (asset.url) return [{ url: asset.url, contentType: asset.contentType, note: asset.note }];
    if (!asset.blob) return [];
    const url = URL.createObjectURL(asset.blob);
    created.push(url);
    return [{ url, contentType: asset.contentType, note: asset.note }];
  });

  return {
    urls,
    release: () => {
      for (const url of created) URL.revokeObjectURL(url);
    },
  };
}
