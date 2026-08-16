import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { GenerationRecord } from "@/features/history/generation-store";
import { cn } from "@/shared/lib/cn";

/**
 * 三个生成面板共用的历史抽屉。
 *
 * 放在面板顶部而不是侧栏：侧栏那块地方给了聊天会话，而且生成记录跟当前面板
 * 绑得更紧（图片的历史只在图片面板有意义）。折叠起来只占一行。
 */
export function GenerationHistory({
  records,
  activeId,
  open,
  onToggle,
  onOpen,
  onDelete,
  onClear,
  emptyHint,
}: {
  records: GenerationRecord[];
  activeId: string | null;
  open: boolean;
  onToggle: () => void;
  onOpen: (record: GenerationRecord) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  emptyHint: string;
}) {
  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          历史 {records.length > 0 ? `(${records.length})` : ""} {open ? "▲" : "▼"}
        </button>
        {open && records.length > 0 ? (
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={onClear}>
            清空本面板
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="max-h-48 overflow-y-auto px-2 pb-2">
          {records.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">{emptyHint}</p>
          ) : (
            records.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent",
                  item.id === activeId && "bg-accent",
                )}
              >
                <button
                  type="button"
                  onClick={() => onOpen(item)}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left text-xs"
                  title={item.title || item.model}
                >
                  <span className="block truncate">{item.title || "（无提示词）"}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()} · {item.model}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="删除这条记录"
                  onClick={() => onDelete(item.id)}
                  className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-60 hover:!opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
