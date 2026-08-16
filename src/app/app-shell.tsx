import { AudioLines, ImageIcon, MessageSquareText, PanelLeft, Plus, Settings2, Trash2, Video, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Backend, Capability } from "@/backends/types";
import type { ChatSession } from "@/features/console/chat-store";
import { cn } from "@/shared/lib/cn";

export type ConsoleMode = "chat" | "image" | "video" | "voice";

const MODES: Array<{ mode: ConsoleMode; label: string; icon: typeof MessageSquareText; needs: Capability[] }> = [
  { mode: "chat", label: "对话", icon: MessageSquareText, needs: ["chat"] },
  { mode: "image", label: "生图", icon: ImageIcon, needs: ["image"] },
  { mode: "video", label: "视频", icon: Video, needs: ["video"] },
  // 语音只要 tts / stt 有一个就显示，面板内部再分子模式
  { mode: "voice", label: "语音", icon: AudioLines, needs: ["tts", "stt"] },
];

/**
 * 按后端实际能力过滤模式。
 *
 * 这是"多后端切换"最直接的体现：连 CPA 时语音会消失（实测它没有 /v1/tts 和 /v1/stt，
 * 返回 404），连 grok2api 时才出现。
 *
 * 探测失败（capabilities 为空）时全部显示 —— 宁可让用户点进去看到错误，
 * 也别因为探测不准把功能藏了。
 */
export function availableModes(backend: Backend): ConsoleMode[] {
  if (backend.capabilities.length === 0) return MODES.map((item) => item.mode);
  return MODES.filter((item) => item.needs.some((need) => backend.capabilities.includes(need))).map((item) => item.mode);
}

export function AppShell({
  backend,
  backends,
  mode,
  onModeChange,
  onBackendChange,
  settingsOpen,
  onToggleSettings,
  sessions,
  currentSessionId,
  onOpenSession,
  onDeleteSession,
  onNewChat,
  children,
}: {
  backend: Backend;
  backends: Backend[];
  mode: ConsoleMode;
  onModeChange: (mode: ConsoleMode) => void;
  onBackendChange: (id: string) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  sessions: ChatSession[];
  currentSessionId: string;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onNewChat: () => void;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const modes = availableModes(backend);

  // 当前模式被后端能力砍掉了（比如从 grok2api 切到 CPA 时正停在语音），回落到第一个可用的
  useEffect(() => {
    if (!modes.includes(mode) && modes.length > 0) onModeChange(modes[0]);
  }, [modes, mode, onModeChange]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* 移动端遮罩。桌面端侧栏常驻，不需要它。 */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "z-50 flex h-full w-56 shrink-0 flex-col border-r bg-sidebar transition-transform duration-200",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0",
          drawerOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="flex items-center gap-1 p-2">
          <span className="px-1.5 text-sm font-medium">网页聊天</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 lg:hidden"
            onClick={() => setDrawerOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {MODES.filter((item) => modes.includes(item.mode)).map((item) => (
            <button
              key={item.mode}
              type="button"
              onClick={() => { onModeChange(item.mode); setDrawerOpen(false); }}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent",
                mode === item.mode && !settingsOpen && "bg-sidebar-accent font-medium",
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>

        {mode === "chat" && !settingsOpen ? (
          <SessionList
            sessions={sessions}
            currentId={currentSessionId}
            onOpen={(id) => { onOpenSession(id); setDrawerOpen(false); }}
            onDelete={onDeleteSession}
            onNew={() => { onNewChat(); setDrawerOpen(false); }}
          />
        ) : (
          <div className="flex-1" />
        )}

        <div className="flex flex-col gap-1.5 border-t p-2">
          <Select value={backend.id} onValueChange={onBackendChange}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {backends.map((item) => (
                <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-8 flex-1 justify-start gap-2 px-2 text-xs font-normal", settingsOpen && "bg-sidebar-accent")}
              onClick={onToggleSettings}
            >
              <Settings2 className="size-3.5" />设置
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 lg:hidden">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDrawerOpen(true)}>
            <PanelLeft className="size-4" />
          </Button>
          <span className="text-sm font-medium">
            {settingsOpen ? "设置" : MODES.find((item) => item.mode === mode)?.label}
          </span>
        </div>

        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

function SessionList({
  sessions,
  currentId,
  onOpen,
  onDelete,
  onNew,
}: {
  sessions: ChatSession[];
  currentId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 pb-1">
        <Button variant="ghost" size="sm" className="h-8 w-full justify-start gap-2 px-2 text-xs font-normal" onClick={onNew}>
          <Plus className="size-3.5" />新对话
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">还没有历史对话</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-sidebar-accent",
                session.id === currentId && "bg-sidebar-accent",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(session.id)}
                className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs"
                title={session.title || "未命名对话"}
              >
                {session.title || "未命名对话"}
              </button>
              <button
                type="button"
                aria-label="删除对话"
                onClick={() => onDelete(session.id)}
                className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-60 hover:!opacity-100"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label="切换主题"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      <span className="text-xs">{theme === "dark" ? "☾" : "☀"}</span>
    </Button>
  );
}
