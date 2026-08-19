import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  createGenerationPersistenceFailure,
  createGenerationId,
  deleteGeneration,
  deleteGenerationsThrough,
  deriveGenerationTitle,
  loadGenerations,
  MAX_GENERATIONS_PER_KIND,
  pruneGenerations,
  saveGeneration,
  type GenerationAsset,
  type GenerationKind,
  type GenerationPersistenceOperation,
  type GenerationPersistenceResult,
  type GenerationRecord,
} from "@/features/history/generation-store";

const PERSISTENCE_ERROR_MESSAGES: Record<GenerationPersistenceOperation, string> = {
  save: "生成结果未能保存，刷新页面后可能丢失",
  delete: "删除未能写入浏览器存储，刷新后记录可能恢复",
  clear: "清空未能写入浏览器存储，刷新后记录可能恢复",
  prune: "旧生成记录清理失败，请检查浏览器存储空间",
};

/**
 * 合并异步读回的旧记录与加载期间刚生成的新记录。
 *
 * `current` 放在前面，所以同 id 时以内存里的新版本为准；统一排序、去重和截断，
 * 让首屏加载与后续 record() 都遵守和 IndexedDB 相同的 50 条上限。
 */
export function mergeGenerationRecords(
  current: GenerationRecord[],
  loaded: GenerationRecord[],
): GenerationRecord[] {
  const byId = new Map<string, GenerationRecord>();
  for (const record of current) byId.set(record.id, record);
  for (const record of loaded) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_GENERATIONS_PER_KIND);
}

/**
 * 三个生成面板共用的历史。
 *
 * 跟 `useChatSessions` 同一套路：IndexedDB 是异步的，所以初始是空列表，
 * 读完再填 —— 首屏不卡 loading，用户可以直接开始生成。
 *
 * 面板只需要 `record()`（生成成功后调一次）和 `replay`（点回一条时读回来），
 * 落盘和裁剪都在这里做掉。
 */
export function useGenerationHistory(scope: string, kind: GenerationKind) {
  const [records, setRecords] = useState<GenerationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [persistenceError, setPersistenceError] = useState<
    Exclude<GenerationPersistenceResult, { ok: true }> | null
  >(null);
  const loadEpochRef = useRef(0);
  const clearedThroughRef = useRef(-Infinity);
  const persistenceAttemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    clearedThroughRef.current = -Infinity;
    persistenceAttemptRef.current += 1;
    setLoading(true);
    setRecords([]);
    setPersistenceError(null);

    void loadGenerations(scope, kind).then((loaded) => {
      if (cancelled || loadEpochRef.current !== loadEpoch) return;
      // 加载 IndexedDB 的过程中，用户可能已经完成了一次生成。不能用 loaded
      // 直接覆盖内存，否则刚出现的结果会从历史里消失。
      setRecords((current) => mergeGenerationRecords(
        current.filter((record) => record.scope === scope && record.kind === kind),
        loaded,
      ));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [scope, kind]);

  useEffect(() => {
    if (!persistenceError) return;
    console.error(`生成历史持久化失败（${persistenceError.operation}）`, persistenceError.error);
    toast.error(PERSISTENCE_ERROR_MESSAGES[persistenceError.operation]);
  }, [persistenceError]);

  const trackPersistence = useCallback((
    promise: Promise<GenerationPersistenceResult>,
    fallbackOperation: GenerationPersistenceOperation,
  ): Promise<GenerationPersistenceResult> => {
    const attempt = persistenceAttemptRef.current + 1;
    persistenceAttemptRef.current = attempt;
    const observed = promise.catch((caught: unknown) =>
      createGenerationPersistenceFailure(fallbackOperation, caught));
    void observed.then((result) => {
      if (persistenceAttemptRef.current !== attempt) return;
      setPersistenceError(result.ok ? null : result);
    });
    return observed;
  }, []);

  const record = useCallback((input: {
    model: string;
    title: string;
    assets: GenerationAsset[];
    text?: string;
    params?: Record<string, unknown>;
  }) => {
    const created: GenerationRecord = {
      id: createGenerationId(),
      scope,
      kind,
      // 清空与紧接着生成可能落在同一毫秒；保证新记录严格晚于清空截止时间。
      createdAt: Math.max(Date.now(), clearedThroughRef.current + 1),
      model: input.model,
      title: deriveGenerationTitle(input.title),
      text: input.text,
      assets: input.assets,
      params: input.params,
    };
    setRecords((previous) => mergeGenerationRecords([created], previous));
    const persisted = saveGeneration(created).then((result) =>
      result.ok ? pruneGenerations(scope, kind) : result);
    void trackPersistence(persisted, "save");
    return created;
  }, [scope, kind, trackPersistence]);

  const remove = useCallback((id: string) => {
    setRecords((previous) => previous.filter((item) => item.id !== id));
    return trackPersistence(deleteGeneration(id), "delete");
  }, [trackPersistence]);

  /** 清掉当前后端 + 当前面板的全部记录。设置页那个「删除全部」是跨后端的，不走这里。 */
  const clear = useCallback(() => {
    const cutoff = Date.now();
    clearedThroughRef.current = cutoff;
    // 让清空前启动、尚未返回的 loadGenerations 失效，避免旧快照重新灌回列表。
    loadEpochRef.current += 1;
    setLoading(false);
    setRecords([]);
    return trackPersistence(deleteGenerationsThrough(scope, kind, cutoff), "clear");
  }, [scope, kind, trackPersistence]);

  const clearPersistenceError = useCallback(() => setPersistenceError(null), []);

  return {
    records,
    loading,
    persistenceError,
    clearPersistenceError,
    record,
    remove,
    clear,
  };
}
