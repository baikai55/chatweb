import { Check, Copy, Download, KeyRound, Loader2, LogOut, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { classifyModel, sortForBrowsing, type CatalogModel } from "@/backends/model-catalog";
import {
  CAPABILITIES,
  MODEL_KINDS,
  WEB_SEARCH_MODES,
  customImageRouteSchema,
  normalizeBaseURL,
  type Backend,
  type Capability,
  type CustomImageRoute,
  type ModelKind,
  type WebSearchMode,
} from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { clearAllSessions } from "@/features/console/chat-store";
import { clearAllGenerations } from "@/features/history/generation-store";
import { toggleCapabilitySelection } from "@/features/settings/capability-selection";
import { listChatInputSTTModels } from "@/features/settings/chat-input-stt-models";
import { estimateUsage } from "@/shared/db/idb";
import { cn } from "@/shared/lib/cn";
import {
  IMAGE_TIMEOUT_MAX_SECONDS,
  IMAGE_TIMEOUT_MIN_SECONDS,
  SEARCH_PROVIDERS,
  patchAppSettings,
  requestNotificationPermission,
  useAppSettings,
  type RecordingMode,
  type SearchProvider,
  type SubmitMode,
} from "@/shared/settings/app-settings";
import {
  BUILTIN_ROUTE_DEFS,
  draftCustomRoute,
  isBuiltinRouteId,
  listImageRoutes,
} from "@/transport/image-routes";
import {
  authenticateWorker,
  clearWorkerAccessToken,
  hasWorkerAccessToken,
} from "@/transport/worker-access";

const KIND_LABELS: Record<ModelKind, string> = {
  auto: "自动归类",
  chat: "对话",
  image: "图片",
  video: "视频",
  tts: "语音合成",
  stt: "语音转写",
  hidden: "隐藏",
};

const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "对话",
  image: "图片",
  video: "视频",
  tts: "语音合成",
  stt: "语音转写",
};

const WEB_SEARCH_MODE_LABELS: Record<WebSearchMode, string> = {
  auto: "联网：自动",
  native: "联网：原生",
  function: "联网：函数",
};

const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
  auto: "自动",
  exa: "Exa",
  "bing-rss": "Bing RSS",
  duckduckgo: "DuckDuckGo",
  searxng: "SearXNG",
  tavily: "Tavily",
  serper: "Serper",
};

/** Radix Select 不允许空字符串作为选项值，用内部哨兵表示“尚未选择”。 */
const NO_CHAT_INPUT_STT_MODEL = "__chatweb_no_chat_input_stt_model__";

/**
 * 模型页上的改动先攒在这里，点保存才落盘。
 *
 * 三样都进草稿：勾选、归类、图片路由 —— 一个面板里有的控件即时生效、
 * 有的要点保存，迟早有人踩。null 表示没有改动，这样干净时永远跟着后端配置走，
 * 不用写同步逻辑。
 *
 * 状态由 Console 持有而不是这里 —— 设置页一关就卸载，草稿放在这里的话
 * 勾了一半点去对话面板就没了。
 */
export type ModelDraft = {
  savedModels: string[];
  modelOverrides: Record<string, ModelKind>;
  webSearchModeOverrides: Record<string, WebSearchMode>;
  imageRouteOverrides: Record<string, string>;
};

export function SettingsView({
  backend, models, fetchedAt, stale, loading, error, onFetchModels, onPatch, onRemove, onAdd, draft, onDraftChange,
  onDataCleared,
}: {
  backend: Backend;
  models: CatalogModel[];
  /** 本地这份目录是什么时候拉的；null 表示还没拉过 */
  fetchedAt: number | null;
  stale: boolean;
  loading: boolean;
  error: string;
  onFetchModels: () => void;
  onPatch: (changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
  draft: ModelDraft | null;
  onDraftChange: (draft: ModelDraft | null) => void;
  /** 删完记录后让上层把内存里的列表也刷掉 */
  onDataCleared: () => void;
}) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-3 p-4">
      <Tabs defaultValue="backend" className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsList aria-label="设置分类">
            <TabsTrigger value="backend" className="shrink-0">后端</TabsTrigger>
            <TabsTrigger value="models" className="shrink-0">模型</TabsTrigger>
            <TabsTrigger value="search" className="shrink-0">联网</TabsTrigger>
            <TabsTrigger value="routes" className="shrink-0">图片路由</TabsTrigger>
            <TabsTrigger value="voice" className="shrink-0">语音</TabsTrigger>
            <TabsTrigger value="behavior" className="shrink-0">行为</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="backend" className="min-h-0 flex-1 overflow-y-auto">
          <BackendSection backend={backend} onPatch={onPatch} onRemove={onRemove} onAdd={onAdd} />
        </TabsContent>
        <TabsContent value="models" className="flex min-h-0 flex-1 flex-col">
          <ModelSection
            backend={backend} models={models} loading={loading} error={error}
            fetchedAt={fetchedAt} stale={stale} onFetchModels={onFetchModels} onPatch={onPatch}
            draft={draft} onDraftChange={onDraftChange}
          />
        </TabsContent>
        <TabsContent value="search" className="min-h-0 flex-1 overflow-y-auto">
          <SearchSettingsSection />
        </TabsContent>
        <TabsContent value="routes" className="min-h-0 flex-1 overflow-y-auto">
          <RouteSection backend={backend} onPatch={onPatch} />
        </TabsContent>
        <TabsContent value="voice" className="min-h-0 flex-1 overflow-y-auto">
          <VoiceSettingsSection backend={backend} models={models} onPatch={onPatch} />
        </TabsContent>
        <TabsContent value="behavior" className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3">
            <BehaviorSection />
            <DataSection onCleared={onDataCleared} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ── 联网 ─────────────────────────────────────────────────────────── */

function SearchSettingsSection() {
  const settings = useAppSettings();
  const [provider, setProvider] = useState<SearchProvider>(settings.searchProvider);
  const [apiKey, setApiKey] = useState(settings.searchApiKey);
  const [baseUrl, setBaseUrl] = useState(settings.searchBaseUrl);
  const [workerPassword, setWorkerPassword] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [workerAuthorized, setWorkerAuthorized] = useState(() => hasWorkerAccessToken());

  const normalizedBaseUrl = baseUrl.trim();
  const dirty = provider !== settings.searchProvider
    || apiKey !== settings.searchApiKey
    || normalizedBaseUrl !== settings.searchBaseUrl;

  function save(): void {
    patchAppSettings({
      searchProvider: provider,
      searchApiKey: apiKey,
      searchBaseUrl: normalizedBaseUrl,
    });
    setBaseUrl(normalizedBaseUrl);
    toast.success("联网搜索设置已保存");
  }

  function restore(): void {
    setProvider(settings.searchProvider);
    setApiKey(settings.searchApiKey);
    setBaseUrl(settings.searchBaseUrl);
  }

  async function authorizeWorker(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workerPassword || authenticating) return;
    setAuthenticating(true);
    try {
      await authenticateWorker(workerPassword);
      setWorkerPassword("");
      setWorkerAuthorized(true);
      toast.success("Worker 访问口令已验证");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAuthenticating(false);
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">函数搜索</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        只供模型联网方式设为「函数搜索」时使用。原生搜索由模型上游执行，不读取这里的搜索源、密钥或地址。
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <Field label="搜索源" hint="自动模式会由搜索服务选择可用来源。">
          <Select value={provider} onValueChange={(value) => setProvider(value as SearchProvider)}>
            <SelectTrigger aria-label="函数搜索使用的搜索源" className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEARCH_PROVIDERS.map((item) => (
                <SelectItem key={item} value={item}>{SEARCH_PROVIDER_LABELS[item]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="API Key" hint="存在本浏览器里。Tavily 和 Serper 使用，其他搜索源会忽略。">
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="h-9 text-sm"
            placeholder="按需填写"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>

        <Field label="接口地址" hint="自定义 SearXNG 实例地址；留空使用搜索服务的默认值。">
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-9 font-mono text-sm"
            placeholder="https://search.example.com"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="mt-3 flex gap-2">
        <Button size="sm" className="h-8 text-xs" disabled={!dirty} onClick={save}>保存</Button>
        {dirty ? (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={restore}>还原</Button>
        ) : null}
      </div>

      <div className="mt-4 border-t pt-4">
        <h3 className="text-sm font-medium">Worker 访问口令</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          部署配置了 ACCESS_PASSWORD 时需要验证。口令不会保存，换取的 token 只保留在当前标签页。
        </p>
        {workerAuthorized ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">当前标签页已验证</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              onClick={() => {
                clearWorkerAccessToken();
                setWorkerAuthorized(false);
              }}
            >
              <LogOut className="size-3.5" />
              清除凭证
            </Button>
          </div>
        ) : (
          <form className="mt-3 flex gap-2" onSubmit={authorizeWorker}>
            <Input
              type="password"
              value={workerPassword}
              onChange={(event) => setWorkerPassword(event.target.value)}
              className="h-9 min-w-0 text-sm"
              aria-label="Worker 访问口令"
              placeholder="按需填写"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button
              type="submit"
              size="sm"
              className="h-9 shrink-0 gap-1.5 text-xs"
              disabled={!workerPassword || authenticating}
            >
              {authenticating ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              验证
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

/* ── 后端 ─────────────────────────────────────────────────────────── */

function BackendSection({
  backend, onPatch, onRemove, onAdd,
}: {
  backend: Backend;
  onPatch: (changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [name, setName] = useState(backend.name);
  const [baseURL, setBaseURL] = useState(backend.baseURL);
  const [apiKey, setApiKey] = useState(backend.apiKey);

  const normalized = normalizeBaseURL(baseURL);
  const dirty = name.trim() !== backend.name
    || normalized !== backend.baseURL
    || apiKey !== backend.apiKey;

  function save(): void {
    if (!normalized) {
      toast.error("地址不能为空");
      return;
    }
    onPatch({ name: name.trim() || new URL(normalized).hostname, baseURL: normalized, apiKey });
    toast.success("已保存");
  }

  function toggleCapability(capability: Capability): void {
    const next = toggleCapabilitySelection(backend.capabilities, capability);
    if (next === backend.capabilities) return;
    onPatch({ capabilities: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">连接</h2>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{backend.flavor}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-8 gap-1 px-2 text-xs" onClick={onAdd}>
            <Plus className="size-3.5" />加后端
          </Button>
          <Button variant="ghost" size="icon" className="size-8" onClick={onRemove} aria-label="删除这个后端">
            <Trash2 className="size-4" />
          </Button>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="名称">
            <Input value={name} onChange={(event) => setName(event.target.value)} className="h-9 text-sm" />
          </Field>
          <Field label="地址" hint={normalized && normalized !== baseURL.trim() ? `会保存成 ${normalized}` : "没写 /v1 会自动补上"}>
            <Input
              value={baseURL} onChange={(event) => setBaseURL(event.target.value)}
              className="h-9 font-mono text-sm"
              inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </Field>
          <Field label="密钥" hint={backend.apiKey ? "存在本浏览器里。别把这个页面的链接分享给别人——对方能直接取出密钥。" : undefined}>
            <Input
              type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
              className="h-9 text-sm" placeholder="留空表示后端不校验"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </Field>
        </div>

        <div className="mt-3 flex gap-2">
          <Button size="sm" className="h-8 text-xs" disabled={!dirty} onClick={save}>保存</Button>
          {dirty ? (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
              setName(backend.name);
              setBaseURL(backend.baseURL);
              setApiKey(backend.apiKey);
            }}>还原</Button>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">显示哪些面板</h2>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {CAPABILITIES.map((capability) => {
            // 一个都没勾时全部显示，所以视觉上也全部点亮
            const on = backend.capabilities.length === 0 || backend.capabilities.includes(capability);
            const onlyEnabled = backend.capabilities.length === 1 && on;
            return (
              <button
                key={capability}
                type="button"
                onClick={() => toggleCapability(capability)}
                aria-pressed={on}
                aria-label={onlyEnabled
                  ? `${CAPABILITY_LABELS[capability]}（至少保留一个面板）`
                  : CAPABILITY_LABELS[capability]}
                disabled={onlyEnabled}
                title={onlyEnabled ? "至少保留一个面板" : undefined}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {CAPABILITY_LABELS[capability]}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          首次未配置时默认全部显示；点击已开启项会关闭它，且至少保留一个面板。
          以前这里是自动探测的 —— <strong className="font-medium">去掉了</strong>：
          那要对 5 个端点各发一次空请求，有些站会把这种密集小请求判成测活直接封号。
          宁可多显示一个面板、点进去看到真实报错，也不值得为此冒风险。
        </p>
      </section>

    </div>
  );
}

/* ── 模型 ─────────────────────────────────────────────────────────── */

function ModelSection({
  backend, models, loading, error, fetchedAt, stale, onFetchModels, onPatch, draft, onDraftChange,
}: {
  backend: Backend;
  models: CatalogModel[];
  loading: boolean;
  error: string;
  fetchedAt: number | null;
  stale: boolean;
  onFetchModels: () => void;
  onPatch: (changes: Partial<Backend>) => void;
  draft: ModelDraft | null;
  onDraftChange: (draft: ModelDraft | null) => void;
}) {
  const [query, setQuery] = useState("");
  const routes = useMemo(() => listImageRoutes(backend), [backend]);
  const defaultRouteName = routes.find((route) => route.id === backend.defaultImageRoute)?.name ?? "图片端点";

  const current: ModelDraft = draft ?? {
    savedModels: backend.savedModels,
    modelOverrides: backend.modelOverrides,
    webSearchModeOverrides: backend.webSearchModeOverrides,
    imageRouteOverrides: backend.imageRouteOverrides,
  };
  const dirty = draft !== null;
  const savedSet = useMemo(() => new Set(current.savedModels), [current.savedModels]);
  // 按目录里实际存在的算，别把上游已经下掉的模型也数进去
  const checkedCount = models.reduce((total, model) => total + (savedSet.has(model.id) ? 1 : 0), 0);

  /**
   * 排序只按提供商和 id，勾选与否不影响位置 ——
   * 这一页是一边扫一边勾的，列表不该在手底下动。
   */
  const listed = useMemo(() => {
    const sorted = sortForBrowsing(models);
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sorted;
    return sorted.filter((model) =>
      model.id.toLowerCase().includes(keyword) || model.vendor.toLowerCase().includes(keyword),
    );
  }, [models, query]);

  function edit(patch: Partial<ModelDraft>): void {
    onDraftChange({ ...current, ...patch });
  }

  function toggle(modelId: string): void {
    edit({
      savedModels: savedSet.has(modelId)
        ? current.savedModels.filter((id) => id !== modelId)
        : [...current.savedModels, modelId],
    });
  }

  function setKind(modelId: string, kind: ModelKind): void {
    const next = { ...current.modelOverrides };
    if (kind === "auto") delete next[modelId];
    else next[modelId] = kind;
    edit({ modelOverrides: next });
  }

  function setRoute(modelId: string, routeId: string): void {
    const next = { ...current.imageRouteOverrides };
    if (!routeId) delete next[modelId];
    else next[modelId] = routeId;
    edit({ imageRouteOverrides: next });
  }

  function setWebSearchMode(modelId: string, mode: WebSearchMode): void {
    const next = { ...current.webSearchModeOverrides };
    if (mode === "auto") delete next[modelId];
    else next[modelId] = mode;
    edit({ webSearchModeOverrides: next });
  }

  /** 草稿里的归类，跟 model-catalog 的 decorate 同一套规则。 */
  function kindOf(model: CatalogModel): CatalogModel["kind"] {
    const override = current.modelOverrides[model.id];
    return override && override !== "auto" ? override : classifyModel(model.id);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border">
      <div className="flex items-center gap-2 border-b p-3">
        <h2 className="text-sm font-medium">模型</h2>
        <span className="text-xs text-muted-foreground">
          {dirty ? `已勾 ${checkedCount} / ${models.length}` : `已保存 ${checkedCount} / ${models.length}`}
        </span>
        <Button
          variant="ghost" size="sm" className="ml-auto h-8 shrink-0 gap-1 px-2 text-xs"
          onClick={onFetchModels} disabled={loading}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          {models.length === 0 ? "获取模型" : "重新获取"}
        </Button>
      </div>

      {error ? (
        <p className="whitespace-pre-wrap border-b p-3 text-xs text-destructive">{error}</p>
      ) : null}

      {models.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          {loading
            ? "正在拉模型列表…"
            : "还没拉过模型列表。点右上角「获取模型」。所有出网请求都由你点出来 —— 进页面不会自动请求后端。"}
        </div>
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
            {listed.map((model) => {
              const checked = savedSet.has(model.id);
              const kind = kindOf(model);
              const overridden = Boolean(current.modelOverrides[model.id] && current.modelOverrides[model.id] !== "auto");
              return (
                <div key={model.id} className={cn("rounded-sm", checked && "bg-accent/50")}>
                  <button
                    type="button"
                    onClick={() => toggle(model.id)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      checked && "border-primary bg-primary text-primary-foreground",
                    )}>
                      {checked ? <Check className="size-3" /> : null}
                    </span>
                    <span className={cn(
                      "w-11 shrink-0 rounded bg-secondary px-1 text-center text-[10px]",
                      overridden && "bg-primary/15 text-primary",
                    )}>
                      {kind}
                    </span>
                    <span className="truncate font-mono">{model.displayName ?? model.id}</span>
                    {model.reasoning ? <span className="shrink-0 text-[10px] text-muted-foreground">推理</span> : null}
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{model.vendor}</span>
                  </button>

                  {checked ? (
                    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-8">
                      <MiniSelect
                        value={current.modelOverrides[model.id] ?? "auto"}
                        onChange={(value) => setKind(model.id, value as ModelKind)}
                        ariaLabel={`${model.id} 归到哪个面板`}
                        options={MODEL_KINDS.map((item) => ({ value: item, label: KIND_LABELS[item] }))}
                      />
                      {kind === "chat" ? (
                        <MiniSelect
                          value={current.webSearchModeOverrides[model.id] ?? "auto"}
                          onChange={(value) => setWebSearchMode(model.id, value as WebSearchMode)}
                          ariaLabel={`${model.id} 的联网搜索方式`}
                          options={WEB_SEARCH_MODES.map((item) => ({
                            value: item,
                            label: WEB_SEARCH_MODE_LABELS[item],
                          }))}
                        />
                      ) : null}
                      {kind === "image" ? (
                        <MiniSelect
                          value={current.imageRouteOverrides[model.id] ?? "__default"}
                          onChange={(value) => setRoute(model.id, value === "__default" ? "" : value)}
                          ariaLabel={`${model.id} 走哪条图片路由`}
                          options={[
                            { value: "__default", label: `默认（${defaultRouteName}）` },
                            ...routes.map((route) => ({ value: route.id, label: route.name })),
                          ]}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 border-t p-3">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {dirty
                ? "改动还没生效，点保存。"
                : fetchedAt
                  ? `勾好后点保存。列表拉取于 ${new Date(fetchedAt).toLocaleString()}${stale ? "，可能过期了" : ""}。`
                  : "勾好后点保存。聊天时的模型选择器只显示保存过的。"}
            </p>
            {dirty ? (
              <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={() => onDraftChange(null)}>
                放弃
              </Button>
            ) : null}
            <Button
              size="sm" className="h-8 shrink-0 text-xs" disabled={!dirty}
              onClick={() => {
                onPatch({
                  savedModels: current.savedModels,
                  modelOverrides: current.modelOverrides,
                  webSearchModeOverrides: current.webSearchModeOverrides,
                  imageRouteOverrides: current.imageRouteOverrides,
                });
                onDraftChange(null);
                toast.success(`已保存 ${checkedCount} 个模型`);
              }}
            >
              保存
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/* ── 图片路由 ─────────────────────────────────────────────────────── */

function RouteSection({
  backend, onPatch,
}: {
  backend: Backend;
  onPatch: (changes: Partial<Backend>) => void;
}) {
  const routes = listImageRoutes(backend);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");

  function startEdit(route: CustomImageRoute): void {
    setEditingId(route.id);
    setDraft(JSON.stringify(route, null, 2));
    setDraftError("");
  }

  function addFrom(source: CustomImageRoute): void {
    const id = `route_${Math.random().toString(36).slice(2, 8)}`;
    const created = draftCustomRoute(source, id);
    onPatch({ customImageRoutes: [...backend.customImageRoutes, created] });
    startEdit(created);
  }

  function saveDraft(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : "JSON 格式不对");
      return;
    }
    const result = customImageRouteSchema.safeParse(parsed);
    if (!result.success) {
      setDraftError(result.error.issues.map((issue) => `${issue.path.join(".") || "根"}：${issue.message}`).join("\n"));
      return;
    }
    if (isBuiltinRouteId(result.data.id)) {
      setDraftError(`id 不能叫 ${result.data.id}，这是内置路由的名字`);
      return;
    }
    const exists = backend.customImageRoutes.some(
      (route) => route.id === result.data.id && route.id !== editingId,
    );
    if (exists) {
      setDraftError(`已经有一条路由叫 ${result.data.id} 了`);
      return;
    }

    onPatch({
      customImageRoutes: backend.customImageRoutes.map((route) =>
        route.id === editingId ? result.data : route,
      ),
      // 改了 id 的话，指向旧 id 的模型和默认值一起跟过去
      ...(editingId && editingId !== result.data.id
        ? {
          defaultImageRoute: backend.defaultImageRoute === editingId ? result.data.id : backend.defaultImageRoute,
          imageRouteOverrides: Object.fromEntries(
            Object.entries(backend.imageRouteOverrides).map(([model, id]) =>
              [model, id === editingId ? result.data.id : id],
            ),
          ),
        }
        : {}),
    });
    setEditingId(null);
    setDraftError("");
    toast.success("路由已保存");
  }

  function removeRoute(id: string): void {
    onPatch({
      customImageRoutes: backend.customImageRoutes.filter((route) => route.id !== id),
      defaultImageRoute: backend.defaultImageRoute === id ? "images" : backend.defaultImageRoute,
      imageRouteOverrides: Object.fromEntries(
        Object.entries(backend.imageRouteOverrides).filter(([, routeId]) => routeId !== id),
      ),
    });
    if (editingId === id) setEditingId(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">默认路由</h2>
        <div className="mt-2">
          <Select value={backend.defaultImageRoute} onValueChange={(value) => onPatch({ defaultImageRoute: value })}>
            <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {routes.map((route) => (
                <SelectItem key={route.id} value={route.id}>{route.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          没有单独指定路由的图片模型走这条。单个模型的路由在「模型」页上勾选后设置。
          实测同一个模型在不同后端认的端点不一样 —— CPA 上的 Nano Banana 拒绝
          <code className="mx-1 rounded bg-secondary px-1 py-0.5 font-mono">/images/generations</code>
          只能走对话端点，这种事从模型名看不出来。
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium">内置路由</h2>
        <div className="mt-2 flex flex-col gap-2">
          {Object.values(BUILTIN_ROUTE_DEFS).map((route) => (
            <div key={route.id} className="flex items-center gap-2 rounded-md bg-secondary/50 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{route.name}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">{route.method} {route.path}</p>
              </div>
              <Button
                variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs"
                onClick={() => addFrom(route)}
              >
                <Copy className="size-3" />复制改
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">自定义路由</h2>
          <Button
            variant="ghost" size="sm" className="ml-auto h-8 gap-1 px-2 text-xs"
            onClick={() => addFrom(BUILTIN_ROUTE_DEFS.chat)}
          >
            <Plus className="size-3.5" />新建
          </Button>
        </div>

        {backend.customImageRoutes.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">还没有自定义路由。从上面复制一条内置的改最省事。</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {backend.customImageRoutes.map((route) => (
              <div key={route.id} className="rounded-md border">
                <div className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{route.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{route.method} {route.path}</p>
                  </div>
                  <Button
                    variant="ghost" size="icon" className="size-7 shrink-0"
                    onClick={() => (editingId === route.id ? setEditingId(null) : startEdit(route))}
                    aria-label={`编辑 ${route.name}`}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="size-7 shrink-0"
                    onClick={() => removeRoute(route.id)}
                    aria-label={`删除 ${route.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>

                {editingId === route.id ? (
                  <div className="border-t p-3">
                    <Textarea
                      value={draft}
                      onChange={(event) => { setDraft(event.target.value); setDraftError(""); }}
                      rows={16}
                      spellCheck={false}
                      className="resize-y font-mono text-xs"
                      aria-label={`${route.name} 的定义`}
                    />
                    {draftError ? (
                      <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{draftError}</p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" className="h-8 text-xs" onClick={saveDraft}>保存</Button>
                      <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setEditingId(null)}>取消</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
          <p>
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">body</code> 是请求体模板。
            整个值写成 <code className="rounded bg-secondary px-1 py-0.5 font-mono">"$prompt"</code>
            会按原类型替换，取不到值的键会被整个剪掉，可选参数因此不用写条件；
            串里的 <code className="rounded bg-secondary px-1 py-0.5 font-mono">{"${prompt}"}</code> 按字符串插值。
          </p>
          <p>
            可用变量：<code className="rounded bg-secondary px-1 py-0.5 font-mono">model prompt messageContent inputImages n size aspectRatio quality responseFormat</code>
            （下划线写法同样认）。面板上只会显示模板真正用到的那几个参数控件。
            参考图路由使用 <code className="rounded bg-secondary px-1 py-0.5 font-mono">messageContent</code>
            生成 OpenAI 多模态消息，或直接使用 <code className="rounded bg-secondary px-1 py-0.5 font-mono">inputImages</code> 数组。
            内置图片路由带参考图时会自动改用 <code className="rounded bg-secondary px-1 py-0.5 font-mono">/images/edits</code>。
          </p>
          <p>
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">imageUrlPaths</code> /
            <code className="rounded bg-secondary px-1 py-0.5 font-mono">b64JsonPaths</code> 是响应里的取图路径，
            点号分隔、<code className="rounded bg-secondary px-1 py-0.5 font-mono">*</code> 展开数组，
            例如 <code className="rounded bg-secondary px-1 py-0.5 font-mono">choices.*.message.images.*.image_url.url</code>。
            留空就用通用提取（会一路深挖字段，也会认正文里的 <code className="rounded bg-secondary px-1 py-0.5 font-mono">![](url)</code>），
            多数后端不用填；填了但一个都没命中时也会回落到通用提取。
          </p>
        </div>
      </section>
    </div>
  );
}

/* ── 语音 ─────────────────────────────────────────────────────────── */

function VoiceSettingsSection({
  backend, models, onPatch,
}: {
  backend: Backend;
  models: CatalogModel[];
  onPatch: (changes: Partial<Backend>) => void;
}) {
  const settings = useAppSettings();
  const sttModels = listChatInputSTTModels(models);
  const selectedSTTAvailable = sttModels.some((model) => model.id === backend.chatInputSTTModel);
  const selectedSTTUnavailable = Boolean(backend.chatInputSTTModel) && !selectedSTTAvailable;

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 className="text-sm font-medium">录音</h2>
        <SettingRow
          label="聊天框显示麦克风"
          description="仅控制聊天输入框里的语音输入按钮；语音页始终显示录音入口。"
          control={
            <Toggle
              checked={settings.showChatMicrophone}
              onChange={() => patchAppSettings({ showChatMicrophone: !settings.showChatMicrophone })}
              label="聊天框显示麦克风"
            />
          }
        />
        <SettingRow
          label="录音操作方式"
          description="聊天输入框和语音页共用。按住说话会在松开时结束；点击模式需再次点击才结束。"
          control={
            <MiniSelect
              value={settings.recordingMode}
              onChange={(value) => patchAppSettings({ recordingMode: value as RecordingMode })}
              ariaLabel="录音操作方式"
              options={[
                { value: "hold", label: "按住说话" },
                { value: "toggle", label: "点击开始/停止" },
              ]}
            />
          }
        />
      </section>

      <section className="rounded-lg border p-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-sm font-medium">聊天转写模型</h2>
          <span
            className="ml-auto max-w-[55%] truncate rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground"
            title={backend.name}
          >
            {backend.name}
          </span>
        </div>

        <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={selectedSTTAvailable ? backend.chatInputSTTModel : NO_CHAT_INPUT_STT_MODEL}
            onValueChange={(value) => onPatch({
              chatInputSTTModel: value === NO_CHAT_INPUT_STT_MODEL ? "" : value,
            })}
            disabled={sttModels.length === 0}
          >
            <SelectTrigger aria-label="聊天语音输入的转写模型" className="h-9 min-w-0 flex-1 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CHAT_INPUT_STT_MODEL}>未选择</SelectItem>
              {sttModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.displayName && model.displayName !== model.id
                    ? `${model.displayName} · ${model.id}`
                    : model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedSTTUnavailable ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 self-start text-xs sm:shrink-0"
              onClick={() => onPatch({ chatInputSTTModel: "" })}
            >
              清除旧选择
            </Button>
          ) : null}
        </div>

        {selectedSTTUnavailable ? (
          <p className="mt-2 break-words text-xs text-destructive">
            此前选择的 <code className="break-all font-mono">{backend.chatInputSTTModel}</code> 已不可用：
            它可能已取消保存、改了归类，或不在当前模型目录中。请重新选择或清除。
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            聊天录音结束后用这个模型转成文字。这里只列出「模型」页里已保存且归类为语音转写的模型；
            {sttModels.length === 0 ? "目前没有候选，请先去模型页保存一个语音转写模型。" : "未选择时聊天麦克风不会开始转写。"}
          </p>
        )}
      </section>
    </div>
  );
}

/* ── 行为 ─────────────────────────────────────────────────────────── */

function BehaviorSection() {
  const settings = useAppSettings();
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const modifier = isMac ? "⌘ + Enter" : "Ctrl + Enter";

  async function toggleNotify(): Promise<void> {
    if (settings.notifyOnComplete) {
      patchAppSettings({ notifyOnComplete: false });
      return;
    }
    if (await requestNotificationPermission()) {
      patchAppSettings({ notifyOnComplete: true });
    } else {
      toast.error("浏览器没给通知权限，去地址栏左边的站点设置里放开");
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <SettingRow
        label="提交方式"
        description={`选 ${modifier} 时 Enter 换行；选 Enter 时 Shift + Enter 换行。手机上一律用发送按钮。`}
        control={
          <MiniSelect
            value={settings.submitMode}
            onChange={(value) => patchAppSettings({ submitMode: value as SubmitMode })}
            ariaLabel="提交方式"
            options={[
              { value: "ctrl-enter", label: modifier },
              { value: "enter", label: "Enter" },
            ]}
          />
        }
      />
      <SettingRow
        label="提交后清空输入框"
        description="关掉的话提示词会留着，方便照着改一版再发。"
        control={
          <Toggle
            checked={settings.clearInputAfterSubmit}
            onChange={() => patchAppSettings({ clearInputAfterSubmit: !settings.clearInputAfterSubmit })}
            label="提交后清空输入框"
          />
        }
      />
      <SettingRow
        label="任务完成后发系统通知"
        description="只在页面切到后台时发 —— 人就盯着看的时候再弹一条纯属打扰。生图实测要 1 到 2 分钟，值得切走干别的。"
        control={
          <Toggle
            checked={settings.notifyOnComplete}
            onChange={() => { void toggleNotify(); }}
            label="任务完成后发系统通知"
          />
        }
      />
      <SettingRow
        label="图片等待上限"
        description={`上游多久没吐字节就判定卡死。默认 300 秒 —— 生图本来就慢（实测单张 68 秒，高质量 103 秒），而且 CPA 换上游重试时会静默一段。太小会把本来会成功的生成掐掉。范围 ${IMAGE_TIMEOUT_MIN_SECONDS}–${IMAGE_TIMEOUT_MAX_SECONDS} 秒。`}
        control={<ImageTimeoutInput />}
      />
    </section>
  );
}

/**
 * 秒数输入。用本地 state 而不是直接写 settings ——
 * 直接写的话删到空或者中途是个非法值就会被 clamp 回去，光标乱跳。
 * 失焦时才规整并落盘。
 */
function ImageTimeoutInput() {
  const settings = useAppSettings();
  const [draft, setDraft] = useState(String(settings.imageTimeoutSeconds));

  useEffect(() => { setDraft(String(settings.imageTimeoutSeconds)); }, [settings.imageTimeoutSeconds]);

  function commit(): void {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(settings.imageTimeoutSeconds));
      return;
    }
    const clamped = Math.min(IMAGE_TIMEOUT_MAX_SECONDS, Math.max(IMAGE_TIMEOUT_MIN_SECONDS, parsed));
    patchAppSettings({ imageTimeoutSeconds: clamped });
    setDraft(String(clamped));
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Input
        type="number"
        inputMode="numeric"
        min={IMAGE_TIMEOUT_MIN_SECONDS}
        max={IMAGE_TIMEOUT_MAX_SECONDS}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        aria-label="图片等待上限（秒）"
        className="h-8 w-20 text-xs"
      />
      <span className="text-xs text-muted-foreground">秒</span>
    </div>
  );
}

/* ── 本地数据 ─────────────────────────────────────────────────────── */

function DataSection({ onCleared }: { onCleared: () => void }) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void estimateUsage().then((result) => { if (!cancelled) setUsage(result); });
    return () => { cancelled = true; };
  }, [busy]);

  async function clearAll(): Promise<void> {
    setBusy(true);
    try {
      // 只清记录，不动后端配置和模型缓存 —— 删了配置用户就得重新填地址和密钥
      await Promise.all([clearAllSessions(), clearAllGenerations()]);
      onCleared();
      setConfirming(false);
      toast.success("已删除全部记录");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-medium">本地数据</h2>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm">删除全部记录</span>
        {confirming ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setConfirming(false)} disabled={busy}>
              取消
            </Button>
            <Button
              size="sm" className="h-8 gap-1 text-xs" onClick={() => { void clearAll(); }} disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              确认删除
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={() => setConfirming(true)}>
            <Trash2 className="size-3.5" />删除
          </Button>
        )}
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        清掉<strong className="font-medium">全部后端</strong>的对话历史和生图/视频/语音记录，删了拿不回来。
        后端配置、密钥和模型列表不动 —— 那些删了得重新填一遍。
        {usage ? ` 当前本地占用约 ${formatBytes(usage.usage)}。` : ""}
      </p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

/* ── 小部件 ───────────────────────────────────────────────────────── */

function SettingRow({
  label, description, control,
}: {
  label: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{label}</span>
        <div className="shrink-0">{control}</div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function Toggle({
  checked, onChange, label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-secondary-foreground/25",
      )}
    >
      <span className={cn(
        "inline-block size-4 rounded-full bg-background shadow transition-transform",
        checked ? "translate-x-[18px]" : "translate-x-[2px]",
      )} />
    </button>
  );
}

function MiniSelect({
  value, options, onChange, ariaLabel,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel} className="h-7 w-auto min-w-0 gap-1.5 rounded-full bg-secondary/70 px-2.5 text-xs shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
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
