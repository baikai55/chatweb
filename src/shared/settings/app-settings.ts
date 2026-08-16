import { z } from "zod";
import { useSyncExternalStore } from "react";

/**
 * 行为设置。
 *
 * 和后端配置一样存 localStorage：量很小，而且首屏就要同步读出来 ——
 * 提交方式决定 Enter 键怎么响应，异步读会有一瞬间按键行为是错的。
 */

const STORAGE_KEY = "chatweb:settings";

export const SUBMIT_MODES = ["enter", "ctrl-enter"] as const;
export type SubmitMode = (typeof SUBMIT_MODES)[number];

/**
 * 图片生成的等待上限（秒）。
 *
 * 默认 300 而不是 SSE 那边通用的 90 —— 图片生成本来就慢（实测 `gpt-image-2`
 * 单张 68 秒，`quality:"high"` 到 103 秒），而且 CPA 会在上游失败时换一家重试，
 * 使用日志里能看到「HTTP 499 context canceled」后面紧跟一条成功记录，
 * 两次加起来的静默时间轻松超过 90 秒。做成可调是因为这个数字完全取决于
 * 你接的是哪家上游，写死多少都会冤枉一部分人。
 */
export const IMAGE_TIMEOUT_MIN_SECONDS = 30;
export const IMAGE_TIMEOUT_MAX_SECONDS = 1800;

export const appSettingsSchema = z.object({
  /**
   * Enter 直接发，还是 Ctrl/⌘+Enter 发。
   * 默认 enter —— 聊天是主界面，回车发送是那里的通行约定。
   */
  submitMode: z.enum(SUBMIT_MODES).default("enter"),
  /** 提交后清空输入框 */
  clearInputAfterSubmit: z.boolean().default(false),
  /** 长任务完成时发系统通知 */
  notifyOnComplete: z.boolean().default(false),
  /** 图片生成等多久算卡死。见上面的常量注释。 */
  imageTimeoutSeconds: z.number()
    .int()
    .min(IMAGE_TIMEOUT_MIN_SECONDS)
    .max(IMAGE_TIMEOUT_MAX_SECONDS)
    .default(300),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const DEFAULTS: AppSettings = appSettingsSchema.parse({});

type Listener = (settings: AppSettings) => void;

const listeners = new Set<Listener>();
let cache: AppSettings | null = null;

export function loadAppSettings(): AppSettings {
  if (cache) return cache;
  cache = readFromStorage();
  return cache;
}

function readFromStorage(): AppSettings {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = appSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULTS;
  } catch {
    // 隐私模式下 localStorage 可能直接抛异常
    return DEFAULTS;
  }
}

export function patchAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadAppSettings(), ...patch };
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 配额满或隐私模式。内存里仍然生效，只是刷新后会丢。
  }
  for (const listener of listeners) listener(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  const wrapped: Listener = () => listener();
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribe, loadAppSettings, () => DEFAULTS);
}

/**
 * 键盘提交判定。
 *
 * enter 档：Enter 发送，Shift+Enter 换行；Ctrl/⌘+Enter 也照发 ——
 * 这一档只是"多一种发送方式"，不该把另一种惯用手势变成哑键。
 * ctrl-enter 档：只有 Ctrl/⌘+Enter 发送，裸 Enter 换行。
 *
 * 两档都要放过输入法组合中的回车 —— 中文选词那一下也是 Enter。
 */
export function shouldSubmitOnKey(
  event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing: boolean } },
  mode: SubmitMode,
): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return false;
  if (mode === "enter") return !event.shiftKey;
  return event.metaKey || event.ctrlKey;
}

/** 开关通知前先要权限。拿不到就别把开关拨过去。 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * 任务完成通知。
 *
 * 只在页面不可见时发 —— 人就盯着页面看的时候再弹一条系统通知纯属打扰，
 * 生成结果本来就已经出现在眼前了。
 */
export function notifyTaskDone(title: string, body: string): void {
  if (!loadAppSettings().notifyOnComplete) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;
  try {
    new Notification(title, { body });
  } catch {
    // 部分浏览器（尤其移动端）在非 Service Worker 上下文里直接抛，忽略即可
  }
}
