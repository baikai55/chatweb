import { Plus, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";

import { useSidebarSlot } from "@/app/sidebar-slot";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import type { GenerationRecord } from "@/features/history/generation-store";
import { cn } from "@/shared/lib/cn";

/**
 * 三个生成面板共用的历史列表。
 *
 * **渲染到侧栏**，跟聊天的会话列表同一个位置 —— 早先做成面板顶部的折叠抽屉，
 * 结果对话的历史在左边、其余三个在内容区，同一个东西两个地方找。
 * 挂载点由 `useSidebarSlot()` 给，拿不到就退回原地渲染。
 *
 * 样式刻意跟 `SessionList` 保持一致（同样的 sidebar-accent、text-xs、
 * hover 才出现的删除按钮），因为它们在用户眼里就是同一个控件。
 */
export function GenerationHistory({
  records,
  activeId,
  onOpen,
  onDelete,
  onClear,
  onNew,
  newLabel,
  newDisabled = false,
  emptyHint,
}: {
  records: GenerationRecord[];
  activeId: string | null;
  onOpen: (record: GenerationRecord) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
  emptyHint: string;
}) {
  const slot = useSidebarSlot();

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal"
          disabled={newDisabled}
          onClick={() => { onNew(); slot.onNavigate(); }}
        >
          <Plus className="size-3.5" />{newLabel}
        </Button>
      </div>

      <div className="flex items-center gap-1 px-4 pb-1">
        <span className="text-xs text-muted-foreground">
          历史{records.length > 0 ? ` (${records.length})` : ""}
        </span>
        {records.length > 0 ? (
          <ConfirmButton className="ml-auto" label="清空" confirmLabel="确认清空" onConfirm={onClear} />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {records.length === 0 ? (
          <p className="px-2 py-4 text-xs leading-5 text-muted-foreground">{emptyHint}</p>
        ) : (
          records.map((item) => (
            <div
              key={item.id}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-sidebar-accent",
                item.id === activeId && "bg-sidebar-accent",
              )}
            >
              <button
                type="button"
                onClick={() => { onOpen(item); slot.onNavigate(); }}
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
                title={item.title || item.model}
              >
                <span className="block truncate text-xs">{item.title || "（无提示词）"}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {new Date(item.createdAt).toLocaleString()} · {item.model}
                </span>
              </button>
              <ConfirmButton
                label={<Trash2 className="size-3" />}
                confirmLabel="确定删除"
                ariaLabel="删除这条记录"
                confirmAriaLabel="确定删除这条记录"
                onConfirm={() => onDelete(item.id)}
                className="h-6 shrink-0 px-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-60 hover:!opacity-100 data-[armed=true]:px-2 data-[armed=true]:opacity-100"
              />
            </div>
          ))
        )}
      </div>
    </div>
  );

  return slot.element ? createPortal(content, slot.element) : content;
}
