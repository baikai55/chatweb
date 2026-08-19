import { STORE_GENERATIONS, idbClear, idbDelete, idbGetByPrefix, idbPut } from "@/shared/db/idb";
import { isAbortError, isRecord } from "@/transport/errors";
import { createRequestTimeoutScope, DEFAULT_MEDIA_REQUEST_TIMEOUT_MS } from "@/transport/request-timeout";

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

export type GenerationPersistenceOperation = "save" | "delete" | "clear" | "prune";

export type GenerationPersistenceFailure = {
  ok: false;
  operation: GenerationPersistenceOperation;
  error: Error;
};

export type GenerationPersistenceResult = { ok: true } | GenerationPersistenceFailure;

export function createGenerationPersistenceFailure(
  operation: GenerationPersistenceOperation,
  caught: unknown,
): GenerationPersistenceFailure {
  return {
    ok: false,
    operation,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

async function persistGeneration(
  operation: GenerationPersistenceOperation,
  action: () => Promise<unknown>,
): Promise<GenerationPersistenceResult> {
  try {
    await action();
    return { ok: true };
  } catch (caught) {
    return createGenerationPersistenceFailure(operation, caught);
  }
}

/** 每个后端每个面板留多少条。存的是二进制，但生图一条能有四张，别无上限。 */
export const MAX_GENERATIONS_PER_KIND = 50;

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
export async function toAsset(url: string, note?: string, signal?: AbortSignal): Promise<GenerationAsset> {
  if (/^https?:/i.test(url)) return { url, note };
  const request = createRequestTimeoutScope(signal);
  try {
    const response = await request.run(
      () => fetch(url, { signal: request.signal }),
      DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
      "连接历史媒体",
    );
    const blob = await request.run(
      () => response.blob(),
      DEFAULT_MEDIA_REQUEST_TIMEOUT_MS,
      "读取历史媒体",
    );
    return { blob, contentType: blob.type || undefined, note };
  } catch (caught) {
    if (signal?.aborted || isAbortError(caught)) throw caught;
    // 转不成就退回存 URL，至少不丢这条记录
    return { url, note };
  } finally {
    request.dispose();
  }
}

/** 侧栏用的一行字：太长的提示词截断。 */
export function deriveGenerationTitle(prompt: string): string {
  const text = prompt.trim().replaceAll(/\s+/g, " ");
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function isGenerationAsset(value: unknown): value is GenerationAsset {
  if (!isRecord(value)) return false;
  return isOptionalString(value.url)
    && (value.blob === undefined || value.blob instanceof Blob)
    && isOptionalString(value.contentType)
    && isOptionalString(value.note);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** 只接受面板能够安全排序、显示和恢复的持久化记录。可选字段继续兼容旧记录。 */
function isGenerationRecord(value: unknown): value is GenerationRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.scope === "string"
    && typeof value.kind === "string"
    && GENERATION_KINDS.includes(value.kind as GenerationKind)
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && typeof value.model === "string"
    && typeof value.title === "string"
    && isOptionalString(value.text)
    && Array.isArray(value.assets)
    && value.assets.every(isGenerationAsset)
    && (value.params === undefined || isRecord(value.params));
}

/** 按创建时间倒序。 */
export async function loadGenerations(scope: string, kind: GenerationKind): Promise<GenerationRecord[]> {
  try {
    const rows = await idbGetByPrefix<unknown>(STORE_GENERATIONS, "byScopeKind", [scope, kind]);
    return rows.filter(isGenerationRecord).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    // 隐私模式或数据库打不开。降级成"没有历史"，不影响生成。
    return [];
  }
}

export function saveGeneration(record: GenerationRecord): Promise<GenerationPersistenceResult> {
  return persistGeneration("save", () => idbPut(STORE_GENERATIONS, record));
}

export function deleteGeneration(id: string): Promise<GenerationPersistenceResult> {
  return persistGeneration("delete", () => idbDelete(STORE_GENERATIONS, id));
}

/** 删除一次“清空”发生之前的当前后端/面板记录，不误删清空后新生成的结果。 */
export async function deleteGenerationsThrough(
  scope: string,
  kind: GenerationKind,
  createdAt: number,
): Promise<GenerationPersistenceResult> {
  return persistGeneration("clear", async () => {
    const rows = await idbGetByPrefix<unknown>(STORE_GENERATIONS, "byScopeKind", [scope, kind]);
    await Promise.all(rows
      .filter(isGenerationRecord)
      .filter((record) => record.createdAt <= createdAt)
      .map((record) => idbDelete(STORE_GENERATIONS, record.id)));
  });
}

/** 超出上限时清理最旧的。保存后异步调一下即可，不用等。 */
export function pruneGenerations(
  scope: string,
  kind: GenerationKind,
): Promise<GenerationPersistenceResult> {
  return persistGeneration("prune", async () => {
    const rows = await idbGetByPrefix<unknown>(STORE_GENERATIONS, "byScopeKind", [scope, kind]);
    const validRows = rows.filter(isGenerationRecord);
    if (validRows.length <= MAX_GENERATIONS_PER_KIND) return;
    const excess = validRows
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, validRows.length - MAX_GENERATIONS_PER_KIND);
    await Promise.all(excess.map((record) => idbDelete(STORE_GENERATIONS, record.id)));
  });
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
