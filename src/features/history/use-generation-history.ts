import { useCallback, useEffect, useState } from "react";

import {
  createGenerationId,
  deleteGeneration,
  deriveGenerationTitle,
  loadGenerations,
  pruneGenerations,
  saveGeneration,
  type GenerationAsset,
  type GenerationKind,
  type GenerationRecord,
} from "@/features/history/generation-store";

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecords([]);

    void loadGenerations(scope, kind).then((loaded) => {
      if (cancelled) return;
      setRecords(loaded);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [scope, kind]);

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
      createdAt: Date.now(),
      model: input.model,
      title: deriveGenerationTitle(input.title),
      text: input.text,
      assets: input.assets,
      params: input.params,
    };
    setRecords((previous) => [created, ...previous]);
    void saveGeneration(created).then(() => pruneGenerations(scope, kind));
    return created;
  }, [scope, kind]);

  const remove = useCallback((id: string) => {
    setRecords((previous) => previous.filter((item) => item.id !== id));
    void deleteGeneration(id);
  }, []);

  /** 清掉当前后端 + 当前面板的全部记录。设置页那个「删除全部」是跨后端的，不走这里。 */
  const clear = useCallback(() => {
    setRecords((previous) => {
      for (const item of previous) void deleteGeneration(item.id);
      return [];
    });
  }, []);

  return { records, loading, record, remove, clear };
}
