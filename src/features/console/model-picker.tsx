import { Check, ChevronsUpDown, Search, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CatalogModel } from "@/backends/model-catalog";
import { cn } from "@/shared/lib/cn";

/**
 * 模型选择器。只列用户在设置里勾选保存过的模型。
 *
 * 为什么不用普通的 Radix Select：即使只看保存的，认真用起来也可能有一二十个，
 * 而且要按提供商分组。带搜索的列表更好用。
 *
 * 为什么不用 shadcn 官方 Combobox：它依赖 cmdk，为一个组件多引一个包不划算。
 */
export function ModelPicker({
  models,
  value,
  onChange,
  onManage,
  disabled,
}: {
  models: CatalogModel[];
  value: string;
  onChange: (modelId: string) => void;
  /** 打开设置页去勾选模型 */
  onManage: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = models.find((model) => model.id === value);

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const matched = keyword
      ? models.filter((model) =>
          model.id.toLowerCase().includes(keyword) ||
          model.vendor.toLowerCase().includes(keyword) ||
          (model.displayName ?? "").toLowerCase().includes(keyword),
        )
      : models;

    const byVendor = new Map<string, CatalogModel[]>();
    for (const model of matched) {
      const list = byVendor.get(model.vendor) ?? [];
      list.push(model);
      byVendor.set(model.vendor, list);
    }
    return Array.from(byVendor, ([label, list]) => ({ label, models: list }));
  }, [models, query]);

  const total = groups.reduce((sum, group) => sum + group.models.length, 0);

  // 一个模型都没保存 —— 直接把按钮变成"去挑模型"的入口，别开一个空弹层
  if (models.length === 0) {
    return (
      <Button variant="ghost" size="sm" onClick={onManage} className="h-8 gap-1 rounded-full px-2.5 text-xs font-normal">
        <Settings2 className="size-3.5" />
        去挑几个模型
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-8 max-w-56 gap-1 rounded-full px-2.5 text-xs font-normal"
        >
          <span className="truncate">{selected?.displayName ?? selected?.id ?? "选择模型"}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        {models.length > 8 ? (
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 opacity-50" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`搜索 ${models.length} 个模型`}
              className="h-9 border-0 pl-8 text-xs shadow-none focus-visible:ring-0"
            />
          </div>
        ) : null}

        <div className="max-h-72 overflow-y-auto p-1">
          {total === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的模型</p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => { onChange(model.id); setOpen(false); setQuery(""); }}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      model.id === value && "bg-accent/60",
                    )}
                  >
                    <Check className={cn("size-3 shrink-0", model.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{model.displayName ?? model.id}</span>
                    {model.reasoning ? (
                      <span className="ml-auto shrink-0 rounded bg-primary/10 px-1 text-[10px]">推理</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={() => { setOpen(false); onManage(); }}
          className="flex w-full items-center gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground hover:bg-accent"
        >
          <Settings2 className="size-3.5" />
          管理模型
        </button>
      </PopoverContent>
    </Popover>
  );
}
