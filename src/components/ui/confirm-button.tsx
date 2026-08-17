import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/cn";

/**
 * 点两下才真的执行的按钮。
 *
 * 侧栏那两个「清空」删的都是攒了很久的东西（整个后端的对话、一个面板的全部
 * 生成记录），而它们就贴在标题旁边 —— 移动端手指宽，误触一下没有任何找补余地。
 * 弹确认框又太重，一个列表标题旁的小按钮不值得打断整屏。
 *
 * 所以第一下把自己变成「确认清空」，几秒内没有第二下就自己变回去 ——
 * 不用点别处取消，放着不管就是取消。
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
  ariaLabel,
  confirmAriaLabel,
  resetAfterMs = 4000,
}: {
  label: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  className?: string;
  ariaLabel?: string;
  confirmAriaLabel?: string;
  resetAfterMs?: number;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function disarm(): void {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={armed ? confirmAriaLabel ?? ariaLabel : ariaLabel}
      data-armed={armed}
      className={cn("h-7 px-2 text-xs font-normal", armed && "text-destructive", className)}
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
          return;
        }
        setArmed(true);
        timerRef.current = setTimeout(() => setArmed(false), resetAfterMs);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
