import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { probeBackend } from "@/backends/capability-probe";
import { fetchModels, modelsForKind, savedModelsOnly, type CatalogModel } from "@/backends/model-catalog";
import { useBackends } from "@/backends/use-backends";
import { createBackend, normalizeBaseURL, type Backend } from "@/backends/types";
import { AppShell, type ConsoleMode } from "@/app/app-shell";
import { ChatPanel } from "@/features/console/chat-panel";
import { useChatSessions } from "@/features/console/use-chat-sessions";
import { ImagePanel } from "@/features/image/image-panel";
import { VideoPanel } from "@/features/video/video-panel";
import { VoicePanel } from "@/features/voice/voice-panel";
import { cn } from "@/shared/lib/cn";

export function App() {
  const { backends, active, save, remove, patch, activate } = useBackends();
  const [adding, setAdding] = useState(false);

  if (backends.length === 0 || adding) {
    return (
      <BackendSetup
        onDone={(backend) => { if (backend) save(backend); setAdding(false); }}
        onCancel={backends.length > 0 ? () => setAdding(false) : undefined}
      />
    );
  }
  if (!active) return null;

  return (
    <Console
      key={active.id}
      backend={active}
      backends={backends}
      onActivate={activate}
      onPatch={(changes) => patch(active.id, changes)}
      onRemove={() => remove(active.id)}
      onAdd={() => setAdding(true)}
    />
  );
}

/**
 * 按后端重新挂载（App 里给了 key={active.id}），
 * 这样切后端时会话、模型、模式全部干净重来，不用手写一堆重置逻辑。
 */
function Console({
  backend,
  backends,
  onActivate,
  onPatch,
  onRemove,
  onAdd,
}: {
  backend: Backend;
  backends: Backend[];
  onActivate: (id: string) => void;
  onPatch: (changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [mode, setMode] = useState<ConsoleMode>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const models = useQuery({
    queryKey: ["models", backend.id, backend.baseURL, backend.savedModels, backend.modelOverrides],
    queryFn: ({ signal }) => fetchModels(backend, { signal }),
    retry: false,
  });

  const saved = savedModelsOnly(models.data ?? []);
  const chatModels = modelsForKind(saved, "chat");
  const chat = useChatSessions(backend.id, chatModels[0]?.id ?? "");

  return (
    <AppShell
      backend={backend}
      backends={backends}
      mode={mode}
      onModeChange={(next) => { setMode(next); setSettingsOpen(false); }}
      onBackendChange={onActivate}
      settingsOpen={settingsOpen}
      onToggleSettings={() => setSettingsOpen((open) => !open)}
      sessions={chat.sessions}
      currentSessionId={chat.current.id}
      onOpenSession={(id) => { chat.open(id); setSettingsOpen(false); }}
      onDeleteSession={chat.remove}
      onNewChat={() => { chat.startNew(chatModels[0]?.id ?? ""); setSettingsOpen(false); }}
    >
      {settingsOpen ? (
        <SettingsView
          backend={backend}
          models={models.data ?? []}
          loading={models.isPending}
          error={models.isError ? (models.error instanceof Error ? models.error.message : String(models.error)) : ""}
          onRefresh={() => { void fetchModels(backend, { force: true }).then(() => models.refetch()); }}
          onPatch={onPatch}
          onRemove={onRemove}
          onAdd={onAdd}
        />
      ) : mode === "chat" ? (
        <ChatPanel
          backend={backend}
          models={chatModels}
          session={chat.current}
          onCommit={chat.commit}
          onManage={() => setSettingsOpen(true)}
        />
      ) : mode === "image" ? (
        <ImagePanel
          backend={backend}
          models={saved}
          onManage={() => setSettingsOpen(true)}
        />
      ) : mode === "video" ? (
        <VideoPanel
          backend={backend}
          models={saved}
          onManage={() => setSettingsOpen(true)}
        />
      ) : (
        <VoicePanel
          backend={backend}
          models={saved}
          onManage={() => setSettingsOpen(true)}
        />
      )}
    </AppShell>
  );
}

/**
 * 设置页。核心是模型勾选 —— CPA 一个部署实测就有 65 个模型，
 * 用户挑出常用的存下来，聊天时的选择器只显示这些。
 */
function SettingsView({
  backend, models, loading, error, onRefresh, onPatch, onRemove, onAdd,
}: {
  backend: Backend;
  models: CatalogModel[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onPatch: (changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const savedCount = models.filter((model) => model.saved).length;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return models;
    return models.filter((model) =>
      model.id.toLowerCase().includes(keyword) || model.vendor.toLowerCase().includes(keyword),
    );
  }, [models, query]);

  function toggle(modelId: string) {
    onPatch({
      savedModels: backend.savedModels.includes(modelId)
        ? backend.savedModels.filter((id) => id !== modelId)
        : [...backend.savedModels, modelId],
    });
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 overflow-y-auto p-4">
      <section className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{backend.name}</h2>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{backend.flavor}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-8 gap-1 px-2 text-xs" onClick={onAdd}>
            <Plus className="size-3.5" />加后端
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{backend.baseURL}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {backend.capabilities.map((capability) => (
            <span key={capability} className="rounded-full bg-secondary px-2 py-0.5 text-xs">{capability}</span>
          ))}
        </div>
        {backend.apiKey ? (
          <p className="mt-3 rounded-md bg-secondary p-2.5 text-xs text-muted-foreground">
            密钥存在本浏览器里。别把这个页面的链接分享给别人——对方能直接取出密钥。
          </p>
        ) : null}
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-lg border">
        <div className="flex items-center gap-2 border-b p-3">
          <h2 className="text-sm font-medium">模型</h2>
          <span className="text-xs text-muted-foreground">已保存 {savedCount} / {models.length}</span>
          <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="size-4 animate-spin" /></div>
        ) : error ? (
          <p className="whitespace-pre-wrap p-4 text-xs text-destructive">{error}</p>
        ) : models.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">没有拉到模型，检查密钥是否有效。</p>
        ) : (
          <>
            <div className="border-b p-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模型"
                className="h-8 text-xs"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {filtered.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => toggle(model.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                    model.saved && "bg-accent/50",
                  )}
                >
                  <span className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    model.saved && "border-primary bg-primary text-primary-foreground",
                  )}>
                    {model.saved ? <Check className="size-3" /> : null}
                  </span>
                  <span className="w-11 shrink-0 rounded bg-secondary px-1 text-center text-[10px]">{model.kind}</span>
                  <span className="truncate font-mono">{model.displayName ?? model.id}</span>
                  {model.reasoning ? <span className="shrink-0 text-[10px] text-muted-foreground">推理</span> : null}
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{model.vendor}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function BackendSetup({
  onDone, onCancel,
}: {
  onDone: (backend: Backend | null) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");

  const probe = useMutation({
    mutationFn: async () => {
      const normalized = normalizeBaseURL(baseURL);
      if (!normalized) throw new Error("地址不能为空");
      return { normalized, result: await probeBackend(normalized) };
    },
    onSuccess: ({ normalized, result }) => {
      if (result.suspicious) toast.warning(t("backend.probeSuspicious"));
      else toast.success(t("backend.probeSuccess", { count: result.capabilities.length }));
      onDone(createBackend({
        name: name.trim() || new URL(normalized).hostname,
        baseURL: normalized,
        apiKey: apiKey.trim(),
        flavor: result.flavor,
        capabilities: result.capabilities,
        probedAt: Date.now(),
      }));
    },
    onError: () => toast.error(t("backend.probeFailed")),
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-lg font-medium">{t("onboarding.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.description")}</p>
      </div>

      <Field label={t("backend.name")}>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("backend.namePlaceholder")} />
      </Field>
      <Field label={t("backend.baseURL")} hint={t("backend.baseURLHint")}>
        <Input
          value={baseURL} onChange={(event) => setBaseURL(event.target.value)}
          placeholder={t("backend.baseURLPlaceholder")}
          inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
      </Field>
      <Field label={t("backend.apiKey")}>
        <Input
          type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
          placeholder={t("backend.apiKeyPlaceholder")}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
      </Field>

      <div className="flex gap-2">
        {onCancel ? <Button variant="outline" className="flex-1" onClick={onCancel}>{t("common.cancel")}</Button> : null}
        <Button className="flex-1" disabled={!baseURL.trim() || probe.isPending} onClick={() => probe.mutate()}>
          {probe.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {probe.isPending ? t("backend.probing") : t("backend.probe")}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
    </label>
  );
}
