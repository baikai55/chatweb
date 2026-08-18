import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyBackendConfig,
  isCatalogStale,
  modelCatalogQueryKey,
  modelsForKind,
  readModelCatalog,
  refreshModelCatalog,
  savedModelsOnly,
} from "@/backends/model-catalog";
import { useBackends } from "@/backends/use-backends";
import { getBackendReferences } from "@/backends/backend-store";
import { createBackend, normalizeBaseURL, type Backend } from "@/backends/types";
import { AppShell, type ConsoleMode } from "@/app/app-shell";
import { ChatPanel } from "@/features/console/chat-panel";
import { useChatSessions } from "@/features/console/use-chat-sessions";
import { ImagePanel } from "@/features/image/image-panel";
import {
  SettingsView,
  type BackendCatalogState,
  type ModelDraft,
} from "@/features/settings/settings-view";
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

  function removeActiveBackend(): void {
    if (!active) return;
    const referencedBy = getBackendReferences(active.id);
    if (referencedBy.length > 0) {
      toast.error(`这个后端正在被 ${referencedBy.map((item) => item.name).join("、")} 的语音设置使用，请先更换 STT/TTS 供应商`);
      return;
    }
    remove(active.id);
  }

  return (
    <Console
      key={active.id}
      backend={active}
      backends={backends}
      onActivate={activate}
      onPatch={(changes) => patch(active.id, changes)}
      onPatchBackend={patch}
      onRemove={removeActiveBackend}
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
  onPatchBackend,
  onRemove,
  onAdd,
}: {
  backend: Backend;
  backends: Backend[];
  onActivate: (id: string) => void;
  onPatch: (changes: Partial<Backend>) => void;
  onPatchBackend: (id: string, changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [mode, setMode] = useState<ConsoleMode>("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceCallActive, setVoiceCallActive] = useState(false);
  /**
   * 模型页的草稿放在这里而不是设置页里 —— 设置页一关就卸载，
   * 勾了一半跳去看一眼对话再回来不该白勾。
   */
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  /** 「删除全部记录」之后 +1，让聊天历史重读一遍。 */
  const [historyToken, setHistoryToken] = useState(0);
  const [fetchErrors, setFetchErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  /**
   * 只读本地缓存，**不打网络**。拉取由用户点「获取模型」触发。
   *
   * query key 里只放会改变结果的东西。勾选、归类覆盖这些只影响标注，
   * 放进 key 会让每勾一下都变成一次新查询 —— 设置页列表会整段闪一下并滚回顶部。
   * 标注在下面用 applyBackendConfig 重算。
   */
  const catalogQueries = useQueries({
    queries: backends.map((target) => ({
      queryKey: modelCatalogQueryKey(target),
      queryFn: () => readModelCatalog(target),
      retry: false,
    })),
  });

  const catalogsByBackendId: Record<string, BackendCatalogState> = {};
  backends.forEach((target, index) => {
    const data = catalogQueries[index]?.data ?? null;
    catalogsByBackendId[target.id] = {
      models: applyBackendConfig(data?.models ?? [], target),
      fetchedAt: data?.fetchedAt ?? null,
      stale: data ? isCatalogStale(data.fetchedAt) : false,
      available: data !== null,
    };
  });
  const activeCatalog = catalogsByBackendId[backend.id] ?? {
    models: [], fetchedAt: null, stale: false, available: false,
  };

  const fetchModels = useMutation({
    mutationFn: async (backendId: string) => {
      const target = backends.find((item) => item.id === backendId);
      if (!target) throw new Error("这个后端已不存在，请重新选择供应商");
      return { target, result: await refreshModelCatalog(target) };
    },
    onMutate: (backendId) => {
      setFetchErrors((current) => {
        const next = { ...current };
        delete next[backendId];
        return next;
      });
    },
    onSuccess: ({ target, result }) => {
      queryClient.setQueryData(modelCatalogQueryKey(target), result);
      // 方言是拉模型时白捡的（读 /models 的响应头），顺手存下来
      if (result.flavor !== target.flavor) onPatchBackend(target.id, { flavor: result.flavor });
      toast.success(`${target.name}：拉到 ${result.models.length} 个模型`);
    },
    onError: (caught, backendId) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      setFetchErrors((current) => ({ ...current, [backendId]: message }));
      toast.error(message);
    },
  });

  const decorated = activeCatalog.models;

  const saved = savedModelsOnly(decorated);
  const chatModels = modelsForKind(saved, "chat");
  const chat = useChatSessions(backend.id, chatModels[0]?.id ?? "", historyToken);

  return (
    <AppShell
      backend={backend}
      backends={backends}
      mode={mode}
      navigationLocked={voiceCallActive}
      onModeChange={(next) => {
        if (voiceCallActive) return;
        setMode(next);
        setSettingsOpen(false);
      }}
      onBackendChange={(id) => {
        if (!voiceCallActive) onActivate(id);
      }}
      settingsOpen={settingsOpen}
      onToggleSettings={() => {
        if (!voiceCallActive) setSettingsOpen((open) => !open);
      }}
      sessions={chat.sessions}
      currentSessionId={chat.current.id}
      onOpenSession={(id) => {
        if (voiceCallActive) return;
        chat.open(id);
        setSettingsOpen(false);
      }}
      onDeleteSession={(id) => {
        if (!voiceCallActive) chat.remove(id);
      }}
      onClearSessions={() => {
        if (!voiceCallActive) chat.clearAll();
      }}
      onNewChat={() => {
        if (voiceCallActive) return;
        chat.startNew(chatModels[0]?.id ?? "");
        setSettingsOpen(false);
      }}
    >
      {settingsOpen ? (
        <SettingsView
          backend={backend}
          backends={backends}
          models={decorated}
          catalogsByBackendId={catalogsByBackendId}
          fetchedAt={activeCatalog.fetchedAt}
          stale={activeCatalog.stale}
          fetchingBackendId={fetchModels.isPending ? fetchModels.variables ?? null : null}
          fetchErrorsByBackendId={fetchErrors}
          fetchBlocked={fetchModels.isPending}
          loading={fetchModels.isPending && fetchModels.variables === backend.id}
          error={fetchErrors[backend.id] ?? ""}
          onFetchModels={() => fetchModels.mutate(backend.id)}
          onFetchBackendModels={(backendId) => fetchModels.mutate(backendId)}
          onPatch={onPatch}
          onPatchBackend={onPatchBackend}
          onRemove={onRemove}
          onAdd={onAdd}
          draft={modelDraft}
          onDraftChange={setModelDraft}
          onDataCleared={() => setHistoryToken((value) => value + 1)}
        />
      ) : mode === "chat" ? (
        <ChatPanel
          backend={backend}
          backends={backends}
          models={chatModels}
          session={chat.current}
          onCommit={chat.commit}
          onManage={() => setSettingsOpen(true)}
          onVoiceCallActiveChange={setVoiceCallActive}
        />
      ) : mode === "image" ? (
        <ImagePanel
          key={backend.id}
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
          backends={backends}
          catalogsByBackendId={catalogsByBackendId}
          models={saved}
          onManage={() => setSettingsOpen(true)}
        />
      )}
    </AppShell>
  );
}

/**
 * 引导页。只收地址和密钥，**不发任何请求**。
 *
 * 以前这里会探测能力再建后端 —— 去掉了：探测要对 5 个端点各发一次空请求，
 * 有些站把这种密集小请求判成测活会封号。方言和模型列表都在用户点
 * 「获取模型」时白捡（`/models` 的响应头就带方言），不值得单独探。
 */
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

  function create(): void {
    const normalized = normalizeBaseURL(baseURL);
    if (!normalized) {
      toast.error("地址不能为空");
      return;
    }
    onDone(createBackend({
      name: name.trim() || new URL(normalized).hostname,
      baseURL: normalized,
      apiKey: apiKey.trim(),
    }));
  }

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
      <Field label={t("backend.apiKey")} hint="加好后去设置页点「获取模型」拉列表">
        <Input
          type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
          placeholder={t("backend.apiKeyPlaceholder")}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
      </Field>

      <div className="flex gap-2">
        {onCancel ? <Button variant="outline" className="flex-1" onClick={onCancel}>{t("common.cancel")}</Button> : null}
        <Button className="flex-1" disabled={!baseURL.trim()} onClick={create}>
          <Plus className="size-4" />
          添加后端
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
