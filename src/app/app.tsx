import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { probeBackend } from "@/backends/capability-probe";
import { applyBackendConfig, fetchModels, modelsForKind, savedModelsOnly } from "@/backends/model-catalog";
import { useBackends } from "@/backends/use-backends";
import { createBackend, normalizeBaseURL, type Backend } from "@/backends/types";
import { AppShell, type ConsoleMode } from "@/app/app-shell";
import { ChatPanel } from "@/features/console/chat-panel";
import { useChatSessions } from "@/features/console/use-chat-sessions";
import { ImagePanel } from "@/features/image/image-panel";
import { SettingsView, type ModelDraft } from "@/features/settings/settings-view";
import { VideoPanel } from "@/features/video/video-panel";
import { VoicePanel } from "@/features/voice/voice-panel";

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
  /**
   * 模型页的草稿放在这里而不是设置页里 —— 设置页一关就卸载，
   * 勾了一半跳去看一眼对话再回来不该白勾。
   */
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);

  /**
   * query key 里只放会改变网络结果的东西。
   * 勾选、归类覆盖这些只影响标注，放进 key 会让每勾一下都变成一次新查询
   * —— 设置页列表会整段闪一下并滚回顶部。标注在下面用 applyBackendConfig 重算。
   */
  const models = useQuery({
    queryKey: ["models", backend.id, backend.baseURL],
    queryFn: ({ signal }) => fetchModels(backend, { signal }),
    retry: false,
  });

  const decorated = useMemo(
    () => applyBackendConfig(models.data ?? [], backend),
    [models.data, backend],
  );

  const saved = savedModelsOnly(decorated);
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
          models={decorated}
          loading={models.isPending}
          error={models.isError ? (models.error instanceof Error ? models.error.message : String(models.error)) : ""}
          onRefresh={() => { void fetchModels(backend, { force: true }).then(() => models.refetch()); }}
          onPatch={onPatch}
          onRemove={onRemove}
          onAdd={onAdd}
          draft={modelDraft}
          onDraftChange={setModelDraft}
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
