import { Check, Copy, Download, KeyRound, Loader2, LogOut, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { classifyModel, sortForBrowsing, type CatalogModel } from "@/backends/model-catalog";
import {
  CAPABILITIES,
  MODEL_KINDS,
  VOICE_PROTOCOLS,
  WEB_SEARCH_MODES,
  customImageRouteSchema,
  customTTSRequestSchema,
  normalizeBaseURL,
  type Backend,
  type Capability,
  type CustomImageRoute,
  type CustomTTSRoute,
  type ModelKind,
  type VoiceBinding,
  type VoiceProtocol,
  type WebSearchMode,
} from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { clearAllSessions } from "@/features/console/chat-store";
import { clearAllGenerations } from "@/features/history/generation-store";
import { toggleCapabilitySelection } from "@/features/settings/capability-selection";
import { estimateUsage, type StorageUsage } from "@/shared/db/idb";
import { cn } from "@/shared/lib/cn";
import {
  IMAGE_TIMEOUT_MAX_SECONDS,
  IMAGE_TIMEOUT_MIN_SECONDS,
  SEARCH_PROVIDERS,
  patchAppSettings,
  requestNotificationPermission,
  useAppSettings,
  type AppSettings,
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
  MIMO_CHAT_TTS_ROUTE,
  isRelativeTTSRoutePath,
  ttsRouteVariables,
} from "@/transport/tts-routes";
import {
  authenticateWorker,
  clearWorkerAccessToken,
  hasWorkerAccessToken,
} from "@/transport/worker-access";
import { isAbortError } from "@/transport/errors";

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

const VOICE_PROTOCOL_LABELS: Record<VoiceProtocol, string> = {
  auto: "自动选择",
  "grok-native": "grok2api 原生",
  "openai-audio": "OpenAI Audio",
};

/** Radix Select 不允许空字符串作为选项值，用内部哨兵表示“尚未选择”。 */
const NO_VOICE_MODEL = "__chatweb_no_voice_model__";
const NO_VOICE_BACKEND = "__chatweb_no_voice_backend__";
const BUILTIN_TTS_ROUTE = "__chatweb_builtin_tts_route__";

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

/** 每个已添加后端的本地模型目录视图；读取它不会发起网络请求。 */
export type BackendCatalogState = {
  models: CatalogModel[];
  fetchedAt: number | null;
  stale: boolean;
  available: boolean;
};

function tryPatchAppSettings(patch: Partial<AppSettings>): AppSettings | null {
  try {
    return patchAppSettings(patch);
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : "浏览器未能保存设置");
    return null;
  }
}

export function SettingsView({
  backend, backends, models, catalogsByBackendId, fetchedAt, stale, fetchingBackendId, fetchErrorsByBackendId,
  fetchBlocked, loading, error, onFetchModels, onFetchBackendModels, onPatch, onPatchBackend, onRemove, onAdd,
  draft, onDraftChange, onDataCleared,
}: {
  backend: Backend;
  backends: Backend[];
  models: CatalogModel[];
  catalogsByBackendId: Record<string, BackendCatalogState>;
  /** 本地这份目录是什么时候拉的；null 表示还没拉过 */
  fetchedAt: number | null;
  stale: boolean;
  fetchingBackendId: string | null;
  fetchErrorsByBackendId: Record<string, string>;
  /** 任一供应商正在拉目录时，先禁用其它获取按钮，避免同一个 mutation 的目标状态互相覆盖。 */
  fetchBlocked: boolean;
  loading: boolean;
  error: string;
  onFetchModels: () => void;
  onFetchBackendModels: (backendId: string) => void;
  onPatch: (changes: Partial<Backend>) => boolean;
  onPatchBackend: (backendId: string, changes: Partial<Backend>) => boolean;
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
            backend={backend} models={models} fetchBlocked={fetchBlocked} loading={loading} error={error}
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
          <VoiceSettingsSection
            backend={backend}
            backends={backends}
            catalogsByBackendId={catalogsByBackendId}
            fetchingBackendId={fetchingBackendId}
            fetchErrorsByBackendId={fetchErrorsByBackendId}
            onFetchBackendModels={onFetchBackendModels}
            onPatch={onPatch}
            onPatchBackend={onPatchBackend}
          />
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

export function SearchSettingsSection() {
  const settings = useAppSettings();
  const [provider, setProvider] = useState<SearchProvider>(settings.searchProvider);
  const [apiKey, setApiKey] = useState(settings.searchApiKey);
  const [baseUrl, setBaseUrl] = useState(settings.searchBaseUrl);
  const [workerPassword, setWorkerPassword] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [workerAuthorized, setWorkerAuthorized] = useState(() => hasWorkerAccessToken());
  const authAbortRef = useRef<AbortController | null>(null);
  const [baseline, setBaseline] = useState(() => ({
    provider: settings.searchProvider,
    apiKey: settings.searchApiKey,
    baseUrl: settings.searchBaseUrl,
  }));

  useEffect(() => () => {
    authAbortRef.current?.abort();
    authAbortRef.current = null;
  }, []);

  const normalizedBaseUrl = baseUrl.trim();
  const dirty = provider !== baseline.provider
    || apiKey !== baseline.apiKey
    || normalizedBaseUrl !== baseline.baseUrl;
  const externallyChanged = settings.searchProvider !== baseline.provider
    || settings.searchApiKey !== baseline.apiKey
    || settings.searchBaseUrl !== baseline.baseUrl;
  const conflict = dirty && externallyChanged;

  useEffect(() => {
    if (!externallyChanged || dirty) return;
    setProvider(settings.searchProvider);
    setApiKey(settings.searchApiKey);
    setBaseUrl(settings.searchBaseUrl);
    setBaseline({
      provider: settings.searchProvider,
      apiKey: settings.searchApiKey,
      baseUrl: settings.searchBaseUrl,
    });
  }, [dirty, externallyChanged, settings.searchProvider, settings.searchApiKey, settings.searchBaseUrl]);

  function save(): void {
    if (conflict) {
      toast.error("联网设置已在其他标签页更新，请先载入最新值");
      return;
    }
    const saved = tryPatchAppSettings({
      searchProvider: provider,
      searchApiKey: apiKey,
      searchBaseUrl: normalizedBaseUrl,
    });
    if (!saved) return;
    setBaseUrl(normalizedBaseUrl);
    setBaseline({ provider, apiKey, baseUrl: normalizedBaseUrl });
    toast.success("联网搜索设置已保存");
  }

  function restore(): void {
    setProvider(settings.searchProvider);
    setApiKey(settings.searchApiKey);
    setBaseUrl(settings.searchBaseUrl);
    setBaseline({
      provider: settings.searchProvider,
      apiKey: settings.searchApiKey,
      baseUrl: settings.searchBaseUrl,
    });
  }

  async function authorizeWorker(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workerPassword || authenticating || authAbortRef.current) return;
    const controller = new AbortController();
    authAbortRef.current = controller;
    setAuthenticating(true);
    try {
      await authenticateWorker(workerPassword, controller.signal);
      if (authAbortRef.current !== controller) return;
      setWorkerPassword("");
      setWorkerAuthorized(true);
      toast.success("Worker 访问口令已验证");
    } catch (caught) {
      if (authAbortRef.current === controller && !isAbortError(caught)) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (authAbortRef.current === controller) {
        authAbortRef.current = null;
        setAuthenticating(false);
      }
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
        <Button size="sm" className="h-8 text-xs" disabled={!dirty || conflict} onClick={save}>保存</Button>
        {dirty ? (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={restore}>
            {conflict ? "载入最新" : "还原"}
          </Button>
        ) : null}
      </div>
      {conflict ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          联网设置已在其他标签页更新。载入最新值后再修改，避免覆盖对方的改动。
        </p>
      ) : null}

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

export function BackendSection({
  backend, onPatch, onRemove, onAdd,
}: {
  backend: Backend;
  onPatch: (changes: Partial<Backend>) => boolean;
  onRemove: () => void;
  onAdd: () => void;
}) {
  const [name, setName] = useState(backend.name);
  const [baseURL, setBaseURL] = useState(backend.baseURL);
  const [apiKey, setApiKey] = useState(backend.apiKey);
  const [baseline, setBaseline] = useState(() => ({
    name: backend.name,
    baseURL: backend.baseURL,
    apiKey: backend.apiKey,
  }));

  const normalized = normalizeBaseURL(baseURL);
  const dirty = name.trim() !== baseline.name
    || normalized !== baseline.baseURL
    || apiKey !== baseline.apiKey;
  const externallyChanged = backend.name !== baseline.name
    || backend.baseURL !== baseline.baseURL
    || backend.apiKey !== baseline.apiKey;
  const conflict = dirty && externallyChanged;

  useEffect(() => {
    if (!externallyChanged || dirty) return;
    setName(backend.name);
    setBaseURL(backend.baseURL);
    setApiKey(backend.apiKey);
    setBaseline({ name: backend.name, baseURL: backend.baseURL, apiKey: backend.apiKey });
  }, [backend.name, backend.baseURL, backend.apiKey, dirty, externallyChanged]);

  function save(): void {
    if (!normalized) {
      toast.error("地址不能为空");
      return;
    }
    if (conflict) {
      toast.error("后端连接已在其他标签页更新，请先载入最新值");
      return;
    }
    const next = { name: name.trim() || new URL(normalized).hostname, baseURL: normalized, apiKey };
    if (!onPatch(next)) return;
    setName(next.name);
    setBaseURL(next.baseURL);
    setBaseline(next);
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
          <Button size="sm" className="h-8 text-xs" disabled={!dirty || conflict} onClick={save}>保存</Button>
          {dirty ? (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => {
              setName(backend.name);
              setBaseURL(backend.baseURL);
              setApiKey(backend.apiKey);
              setBaseline({ name: backend.name, baseURL: backend.baseURL, apiKey: backend.apiKey });
            }}>{conflict ? "载入最新" : "还原"}</Button>
          ) : null}
        </div>
        {conflict ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            后端连接已在其他标签页更新。载入最新值后再修改，避免覆盖对方的改动。
          </p>
        ) : null}
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
  backend, models, fetchBlocked, loading, error, fetchedAt, stale, onFetchModels, onPatch, draft, onDraftChange,
}: {
  backend: Backend;
  models: CatalogModel[];
  fetchBlocked: boolean;
  loading: boolean;
  error: string;
  fetchedAt: number | null;
  stale: boolean;
  onFetchModels: () => void;
  onPatch: (changes: Partial<Backend>) => boolean;
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
          onClick={onFetchModels} disabled={fetchBlocked}
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
                if (!onPatch({
                  savedModels: current.savedModels,
                  modelOverrides: current.modelOverrides,
                  webSearchModeOverrides: current.webSearchModeOverrides,
                  imageRouteOverrides: current.imageRouteOverrides,
                })) return;
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
  backend,
  backends,
  catalogsByBackendId,
  fetchingBackendId,
  fetchErrorsByBackendId,
  onFetchBackendModels,
  onPatch,
  onPatchBackend,
}: {
  backend: Backend;
  backends: Backend[];
  catalogsByBackendId: Record<string, BackendCatalogState>;
  fetchingBackendId: string | null;
  fetchErrorsByBackendId: Record<string, string>;
  onFetchBackendModels: (backendId: string) => void;
  onPatch: (changes: Partial<Backend>) => boolean;
  onPatchBackend: (backendId: string, changes: Partial<Backend>) => boolean;
}) {
  const settings = useAppSettings();

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
              onChange={() => { tryPatchAppSettings({ showChatMicrophone: !settings.showChatMicrophone }); }}
              label="聊天框显示麦克风"
            />
          }
        />
      </section>

      <VoiceRouteSettingsCard
        kind="stt"
        owner={backend}
        backends={backends}
        catalogsByBackendId={catalogsByBackendId}
        fetchingBackendId={fetchingBackendId}
        fetchErrorsByBackendId={fetchErrorsByBackendId}
        onFetchBackendModels={onFetchBackendModels}
        onPatch={onPatch}
      />
      <CustomTTSRouteSection
        owner={backend}
        backends={backends}
        onPatchBackend={onPatchBackend}
      />
      <VoiceRouteSettingsCard
        kind="tts"
        owner={backend}
        backends={backends}
        catalogsByBackendId={catalogsByBackendId}
        fetchingBackendId={fetchingBackendId}
        fetchErrorsByBackendId={fetchErrorsByBackendId}
        onFetchBackendModels={onFetchBackendModels}
        onPatch={onPatch}
      />
    </div>
  );
}

function CustomTTSRouteSection({
  owner,
  backends,
  onPatchBackend,
}: {
  owner: Backend;
  backends: Backend[];
  onPatchBackend: (backendId: string, changes: Partial<Backend>) => boolean;
}) {
  const configuredBackendId = owner.voiceRouting.tts.backendId?.trim() || owner.id;
  const [backendId, setBackendId] = useState(configuredBackendId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const target = backends.find((item) => item.id === backendId);

  useEffect(() => {
    setBackendId(configuredBackendId);
    setEditingId(null);
    setDraftError("");
  }, [configuredBackendId]);

  function startEdit(route: CustomTTSRoute): void {
    setEditingId(route.id);
    setDraft(JSON.stringify(ttsRequestFormat(route), null, 2));
    setDraftError("");
  }

  function addMiMoRoute(): void {
    if (!target) {
      toast.error("请先选择保存 TTS 路由的供应商");
      return;
    }
    const created: CustomTTSRoute = {
      ...MIMO_CHAT_TTS_ROUTE,
      id: nextTTSRouteId(target.customTTSRoutes, MIMO_CHAT_TTS_ROUTE.id),
      query: { ...MIMO_CHAT_TTS_ROUTE.query },
      body: JSON.parse(JSON.stringify(MIMO_CHAT_TTS_ROUTE.body)) as Record<string, unknown>,
      audioUrlPaths: [...MIMO_CHAT_TTS_ROUTE.audioUrlPaths],
      audioBase64Paths: [...MIMO_CHAT_TTS_ROUTE.audioBase64Paths],
    };
    onPatchBackend(target.id, { customTTSRoutes: [...target.customTTSRoutes, created] });
    startEdit(created);
    toast.success("已创建 MiMo TTS 路由模板，请检查后保存");
  }

  function saveDraft(): void {
    if (!target || !editingId) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : "JSON 格式不对");
      return;
    }
    const result = customTTSRequestSchema.safeParse(parsed);
    if (!result.success) {
      setDraftError(result.error.issues.map((issue) => `${issue.path.join(".") || "根"}：${issue.message}`).join("\n"));
      return;
    }
    if (!isRelativeTTSRoutePath(result.data.path)) {
      setDraftError("path：只能填写相对于所选供应商 Base URL 的接口路径，不能填写完整网址");
      return;
    }
    const currentRoute = target.customTTSRoutes.find((route) => route.id === editingId);
    if (!currentRoute) {
      setDraftError("这条路由已经不存在，请关闭编辑器后重新选择");
      return;
    }
    if (!onPatchBackend(target.id, {
      customTTSRoutes: target.customTTSRoutes.map((route) => route.id === editingId
        ? { ...route, ...result.data }
        : route),
    })) return;
    setEditingId(null);
    setDraftError("");
    toast.success("TTS 路由已保存");
  }

  function removeRoute(route: CustomTTSRoute): void {
    if (!target) return;
    const referencedBy = backends.filter((source) => {
      const binding = source.voiceRouting.tts;
      const bindingTargetId = binding.backendId?.trim() || source.id;
      return bindingTargetId === target.id && binding.routeId === route.id;
    });
    if (referencedBy.length > 0) {
      toast.error(`路由正在被 ${referencedBy.map((item) => item.name).join("、")} 的 TTS 设置使用，请先取消选择`);
      return;
    }
    if (!onPatchBackend(target.id, {
      customTTSRoutes: target.customTTSRoutes.filter((item) => item.id !== route.id),
    })) return;
    if (editingId === route.id) setEditingId(null);
    toast.success("TTS 路由已删除");
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">自定义 TTS 路由</h2>
          <p className="mt-1 text-xs text-muted-foreground">路由保存在实际供应商上；创建和切换只修改本地配置，不会请求上游。</p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={addMiMoRoute} disabled={!target}>
          <Plus className="size-3.5" />新建路由
        </Button>
      </div>

      <div className="mt-3">
        <Field label="路由所属供应商" hint="默认跟随上面 TTS 已选择的供应商，也可以在这里切换后管理其他供应商的路由。">
          <Select
            value={backendId}
            onValueChange={(value) => { setBackendId(value); setEditingId(null); setDraftError(""); }}
          >
            <SelectTrigger aria-label="自定义 TTS 路由所属供应商" className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {backends.map((item) => <SelectItem key={item.id} value={item.id}>{backendOptionLabel(item)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {!target ? (
        <p className="mt-3 text-xs text-destructive">原供应商已删除，请重新选择。</p>
      ) : target.customTTSRoutes.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">还没有自定义 TTS 路由。使用小米 mimo-v2.5-tts 时，可直接创建上面的 MiMo 模板。</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {target.customTTSRoutes.map((route) => {
            const variables = [...ttsRouteVariables(route)];
            return (
              <div key={route.id} className="rounded-md border">
                <div className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{route.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{route.method} {route.path}</p>
                    <p className="truncate text-[10px] text-muted-foreground">参数：{variables.length > 0 ? variables.join(" · ") : "无模板变量"}</p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => editingId === route.id ? setEditingId(null) : startEdit(route)} aria-label={`编辑 ${route.name}`}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => removeRoute(route)} aria-label={`删除 ${route.name}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {editingId === route.id ? (
                  <div className="border-t p-3">
                    <Textarea value={draft} onChange={(event) => { setDraft(event.target.value); setDraftError(""); }} rows={18} spellCheck={false} className="resize-y font-mono text-xs" aria-label={`${route.name} 的定义`} />
                    {draftError ? <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{draftError}</p> : null}
                    <div className="mt-2 flex gap-2">
                      <Button type="button" size="sm" className="h-8 text-xs" onClick={saveDraft}>保存</Button>
                      <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setEditingId(null)}>取消</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 space-y-1 text-xs leading-5 text-muted-foreground">
        <p>编辑器只保存请求格式：<code className="rounded bg-secondary px-1 py-0.5 font-mono">path</code>、<code className="rounded bg-secondary px-1 py-0.5 font-mono">method</code>、<code className="rounded bg-secondary px-1 py-0.5 font-mono">query</code> 和 <code className="rounded bg-secondary px-1 py-0.5 font-mono">body</code>。<code className="rounded bg-secondary px-1 py-0.5 font-mono">path</code> 只能填写相对于所选供应商 Base URL 的接口路径，例如 <code className="rounded bg-secondary px-1 py-0.5 font-mono">/chat/completions</code>。</p>
        <p>可用模板变量：<code className="rounded bg-secondary px-1 py-0.5 font-mono">model text voice format speed language</code>。</p>
        <p>MiMo 的响应音频取值、音频格式和默认声线由模板固定，不需要在编辑器里填写。</p>
      </div>
    </section>
  );
}

function ttsRequestFormat(route: CustomTTSRoute): Record<string, unknown> {
  return {
    path: route.path,
    method: route.method,
    query: route.query,
    body: route.body,
  };
}

export function nextTTSRouteId(routes: CustomTTSRoute[], preferred: string): string {
  const ids = new Set(routes.map((route) => route.id));
  if (!ids.has(preferred)) return preferred;
  let suffix = 2;
  while (ids.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

export type VoiceRouteKind = "stt" | "tts";
export type VoiceRouteDraft = {
  backendId: string;
  model: string;
  protocol: VoiceProtocol;
  routeId: string;
};

function VoiceRouteSettingsCard({
  kind,
  owner,
  backends,
  catalogsByBackendId,
  fetchingBackendId,
  fetchErrorsByBackendId,
  onFetchBackendModels,
  onPatch,
}: {
  kind: VoiceRouteKind;
  owner: Backend;
  backends: Backend[];
  catalogsByBackendId: Record<string, BackendCatalogState>;
  fetchingBackendId: string | null;
  fetchErrorsByBackendId: Record<string, string>;
  onFetchBackendModels: (backendId: string) => void;
  onPatch: (changes: Partial<Backend>) => boolean;
}) {
  const initial = initialVoiceRoute(owner, backends, kind);
  const initialKey = `${initial.backendId}\u0000${initial.model}\u0000${initial.protocol}\u0000${initial.routeId}`;
  const [draft, setDraft] = useState<VoiceRouteDraft>(initial);

  useEffect(() => { setDraft(initial); }, [initialKey]);

  const target = backends.find((item) => item.id === draft.backendId);
  const catalog = target ? catalogsByBackendId[target.id] : undefined;
  const { recommended, others } = groupVoiceRouteModels(catalog?.models ?? [], kind);
  const selectedMissing = Boolean(draft.model)
    && !(catalog?.models ?? []).some((model) => model.id === draft.model);
  const dirty = draft.backendId !== initial.backendId
    || draft.model !== initial.model
    || draft.protocol !== initial.protocol
    || draft.routeId !== initial.routeId;
  const fetching = Boolean(target && fetchingBackendId === target.id);
  const resolvedProtocol = draft.protocol === "auto"
    ? (target?.flavor === "grok2api" ? "grok-native" : "openai-audio")
    : draft.protocol;
  const customRoute = kind === "tts"
    ? target?.customTTSRoutes.find((route) => route.id === draft.routeId)
    : undefined;
  const endpoint = customRoute?.path ?? (kind === "stt"
    ? (resolvedProtocol === "grok-native" ? "/stt" : "/audio/transcriptions")
    : (resolvedProtocol === "grok-native" ? "/tts" : "/audio/speech"));
  const title = kind === "stt" ? "语音转写 STT" : "语音合成 TTS";

  function save(): void {
    if (!target) {
      toast.error(`请先选择${title}供应商`);
      return;
    }
    const model = draft.model.trim();
    if (!model) {
      toast.error(`请先选择${title}模型`);
      return;
    }
    if (kind === "tts" && draft.routeId && !target.customTTSRoutes.some((route) => route.id === draft.routeId)) {
      toast.error("选择的 TTS 请求路由已不存在，请重新选择");
      return;
    }
    const binding: VoiceBinding = {
      backendId: target.id === owner.id ? "" : target.id,
      model,
      protocol: draft.protocol,
      routeId: kind === "tts" ? draft.routeId : "",
    };
    if (!onPatch({
      voiceRouting: {
        ...owner.voiceRouting,
        [kind]: binding,
      },
    })) return;
    toast.success(`${title}设置已保存`);
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="shrink-0 text-sm font-medium">{title}</h2>
        {target ? (
          <span
            className="ml-auto max-w-[55%] truncate rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground"
            title={target.baseURL}
          >
            {target.name}
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="供应商" hint="复用“后端”里已经保存的地址和密钥。切换这里只读本地缓存。">
          <Select
            value={draft.backendId || NO_VOICE_BACKEND}
            onValueChange={(value) => setDraft(voiceRouteDraftForBackend(
              value === NO_VOICE_BACKEND ? "" : value,
            ))}
          >
            <SelectTrigger aria-label={`${title}供应商`} className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!draft.backendId ? <SelectItem value={NO_VOICE_BACKEND}>请选择供应商</SelectItem> : null}
              {draft.backendId && !target ? (
                <SelectItem value={draft.backendId}>原供应商已删除</SelectItem>
              ) : null}
              {backends.map((item) => (
                <SelectItem key={item.id} value={item.id}>{backendOptionLabel(item)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="接口格式" hint={`当前会调用 ${endpoint}；自动模式按获取模型时识别到的后端类型选择。`}>
          <Select
            value={draft.protocol}
            onValueChange={(value) => setDraft((current) => ({
              ...current,
              protocol: value as VoiceProtocol,
            }))}
          >
            <SelectTrigger aria-label={`${title}接口格式`} className="h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VOICE_PROTOCOLS.map((protocol) => (
                <SelectItem key={protocol} value={protocol}>{VOICE_PROTOCOL_LABELS[protocol]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {kind === "tts" ? (
          <Field label="请求路由" hint="内置路由使用上面的接口格式；自定义路由可以改走 Chat Completions 等端点。">
            <Select
              value={draft.routeId || BUILTIN_TTS_ROUTE}
              onValueChange={(value) => setDraft((current) => ({
                ...current,
                routeId: value === BUILTIN_TTS_ROUTE ? "" : value,
              }))}
              disabled={!target}
            >
              <SelectTrigger aria-label="语音合成 TTS 请求路由" className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={BUILTIN_TTS_ROUTE}>内置 · 按接口格式</SelectItem>
                {draft.routeId && !customRoute ? (
                  <SelectItem value={draft.routeId}>{draft.routeId} · 已失效</SelectItem>
                ) : null}
                {(target?.customTTSRoutes ?? []).map((route) => (
                  <SelectItem key={route.id} value={route.id}>{route.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>

      <div className="mt-3">
        <Field
          label="模型"
          hint={catalog?.available
            ? `本地目录${catalog.fetchedAt ? `获取于 ${new Date(catalog.fetchedAt).toLocaleString()}` : "已读取"}${catalog.stale ? "，可能已过期" : ""}；推荐模型排在前面，其余模型仍可选择。`
            : "尚未获取这个供应商的模型。切换供应商不会联网，只有点击右侧按钮才会请求。"}
        >
          <div className="flex min-w-0 gap-2">
            <Select
              value={draft.model || NO_VOICE_MODEL}
              onValueChange={(value) => setDraft((current) => ({
                ...current,
                model: value === NO_VOICE_MODEL ? "" : value,
              }))}
              disabled={!target || (!catalog?.available && !draft.model)}
            >
              <SelectTrigger aria-label={`${title}模型`} className="h-9 min-w-0 flex-1 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VOICE_MODEL}>未选择</SelectItem>
                {selectedMissing ? (
                  <SelectItem value={draft.model}>{draft.model} · 不在当前目录</SelectItem>
                ) : null}
                {recommended.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>推荐的 {kind.toUpperCase()} 模型</SelectLabel>
                    {recommended.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{catalogModelLabel(model)}</SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {recommended.length > 0 && others.length > 0 ? <SelectSeparator /> : null}
                {others.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>全部其他模型</SelectLabel>
                    {others.map((model) => (
                      <SelectItem key={model.id} value={model.id}>{catalogModelLabel(model)}</SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5 text-xs"
              disabled={!target || fetchingBackendId !== null}
              onClick={() => { if (target) onFetchBackendModels(target.id); }}
            >
              {fetching ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {catalog?.available ? "重新获取" : "获取模型"}
            </Button>
          </div>
        </Field>
      </div>

      {target?.mode === "proxy" ? (
        <p className="mt-2 text-xs text-destructive">当前语音引用暂不支持 proxy 后端，请选择 direct 后端。</p>
      ) : null}
      {target && fetchErrorsByBackendId[target.id] ? (
        <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{fetchErrorsByBackendId[target.id]}</p>
      ) : null}
      {catalog?.available && catalog.models.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">这个供应商的模型目录为空。</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Button size="sm" className="h-8 text-xs" disabled={!dirty || !target || !draft.model.trim()} onClick={save}>保存</Button>
        {dirty ? (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setDraft(initial)}>还原</Button>
        ) : null}
      </div>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        {kind === "stt" ? "聊天麦克风和语音页的转写" : "语音页的语音合成"}
        会使用这里选择的供应商和模型，不会切换顶部当前聊天后端。
      </p>
    </section>
  );
}

/**
 * 切换供应商只改本地草稿：清掉上一家的模型，并回到自动协议。
 * 这个 helper 不接收任何请求函数，避免下拉框变化时误触发模型拉取。
 */
export function voiceRouteDraftForBackend(backendId: string): VoiceRouteDraft {
  return { backendId, model: "", protocol: "auto", routeId: "" };
}

/** 归类只决定推荐顺序；目录里的其余模型（包括 hidden）仍允许用户自行选择。 */
export function groupVoiceRouteModels(
  models: CatalogModel[],
  kind: VoiceRouteKind,
): { recommended: CatalogModel[]; others: CatalogModel[] } {
  const recommended = models.filter((model) => model.kind === kind);
  const recommendedIds = new Set(recommended.map((model) => model.id));
  return {
    recommended,
    others: models.filter((model) => !recommendedIds.has(model.id)),
  };
}

export function initialVoiceRoute(owner: Backend, backends: Backend[], kind: VoiceRouteKind): VoiceRouteDraft {
  const binding = owner.voiceRouting[kind];
  if (binding.model.trim()) {
    return {
      backendId: binding.backendId.trim() || owner.id,
      model: binding.model.trim(),
      protocol: binding.protocol,
      routeId: kind === "tts" ? (binding.routeId ?? "").trim() : "",
    };
  }

  if (kind === "stt" && owner.sttProvider.type === "openai-compatible") {
    const legacyBaseURL = normalizeBaseURL(owner.sttProvider.baseURL);
    const matched = backends.find((item) => (
      normalizeBaseURL(item.baseURL) === legacyBaseURL
      && item.apiKey === owner.sttProvider.apiKey
    ));
    return {
      backendId: matched?.id ?? "",
      model: owner.sttProvider.model.trim(),
      protocol: "openai-audio",
      routeId: "",
    };
  }

  return {
    backendId: owner.id,
    model: kind === "stt" ? owner.chatInputSTTModel.trim() : "",
    // 旧版 chatInputSTTModel 明确对应当前后端的 /stt；没有旧配置时让方言决定端点。
    protocol: kind === "stt" && owner.chatInputSTTModel.trim() ? "grok-native" : "auto",
    routeId: "",
  };
}

function backendOptionLabel(backend: Backend): string {
  try {
    return `${backend.name} · ${new URL(backend.baseURL).host}`;
  } catch {
    return backend.name;
  }
}

function catalogModelLabel(model: CatalogModel): string {
  return model.displayName && model.displayName !== model.id
    ? `${model.displayName} · ${model.id}`
    : model.id;
}

/* ── 行为 ─────────────────────────────────────────────────────────── */

function BehaviorSection() {
  const settings = useAppSettings();
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const modifier = isMac ? "⌘ + Enter" : "Ctrl + Enter";

  async function toggleNotify(): Promise<void> {
    if (settings.notifyOnComplete) {
      tryPatchAppSettings({ notifyOnComplete: false });
      return;
    }
    if (await requestNotificationPermission()) {
      tryPatchAppSettings({ notifyOnComplete: true });
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
            onChange={(value) => { tryPatchAppSettings({ submitMode: value as SubmitMode }); }}
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
            onChange={() => { tryPatchAppSettings({ clearInputAfterSubmit: !settings.clearInputAfterSubmit }); }}
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
export function ImageTimeoutInput() {
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
    const saved = tryPatchAppSettings({ imageTimeoutSeconds: clamped });
    setDraft(String(saved ? clamped : settings.imageTimeoutSeconds));
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
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void estimateUsage()
      .then((result) => { if (!cancelled) setUsage(result); })
      .catch(() => { if (!cancelled) setUsage(null); });
    return () => { cancelled = true; };
  }, [busy]);

  async function clearAll(): Promise<void> {
    setBusy(true);
    // 只清记录，不动后端配置和模型缓存 —— 删了配置用户就得重新填地址和密钥
    const result = await clearStoredRecords({ onSessionsCleared: onCleared });
    if (result.sessionsCleared && result.generationsCleared) {
      setConfirming(false);
      toast.success("已删除全部记录，离线应用缓存和模型列表已保留");
    } else {
      const failed = [
        !result.sessionsCleared ? "聊天记录" : null,
        !result.generationsCleared ? "生成记录" : null,
      ].filter(Boolean).join("和");
      const succeeded = [
        result.sessionsCleared ? "聊天记录" : null,
        result.generationsCleared ? "生成记录" : null,
      ].filter(Boolean).join("和");
      toast.error(`${succeeded ? `${succeeded}已删除；` : ""}${failed}删除失败，请重试`);
    }
    setBusy(false);
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
        {usage ? <StorageUsageSummary usage={usage} /> : null}
      </p>
    </section>
  );
}

export async function clearStoredRecords(
  options: {
    clearSessions?: () => Promise<void>;
    clearGenerations?: () => Promise<void>;
    onSessionsCleared?: () => void;
  } = {},
): Promise<{ sessionsCleared: boolean; generationsCleared: boolean }> {
  const clearSessions = options.clearSessions ?? clearAllSessions;
  const clearGenerations = options.clearGenerations ?? clearAllGenerations;
  const sessionsTask = Promise.resolve().then(clearSessions).then(() => {
    options.onSessionsCleared?.();
  });
  const [sessions, generations] = await Promise.allSettled([
    sessionsTask,
    Promise.resolve().then(clearGenerations),
  ]);
  return {
    sessionsCleared: sessions.status === "fulfilled",
    generationsCleared: generations.status === "fulfilled",
  };
}

function StorageUsageSummary({ usage }: { usage: StorageUsage }) {
  const recordSummary = usage.recordUsage !== undefined
    ? ` 当前对话和生成记录约 ${formatBytes(usage.recordUsage)}。`
    : "";
  if (usage.cacheUsage !== undefined || usage.indexedDBUsage !== undefined) {
    return (
      <>
        {recordSummary}
        {`本站共占用约 ${formatBytes(usage.usage)}`}
        {usage.indexedDBUsage !== undefined
          ? `，IndexedDB 数据约 ${formatBytes(usage.indexedDBUsage)}（含保留的模型列表）`
          : ""}
        {usage.cacheUsage !== undefined ? `，离线应用缓存约 ${formatBytes(usage.cacheUsage)}` : ""}
        。
      </>
    );
  }
  return <>{recordSummary}{`本站总占用约 ${formatBytes(usage.usage)}（包含离线应用缓存，不等于记录大小）。`}</>;
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
