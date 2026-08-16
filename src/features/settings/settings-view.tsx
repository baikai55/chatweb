import { Check, Copy, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { probeBackend } from "@/backends/capability-probe";
import { classifyModel, sortForBrowsing, type CatalogModel } from "@/backends/model-catalog";
import {
  CAPABILITIES,
  MODEL_KINDS,
  customImageRouteSchema,
  normalizeBaseURL,
  type Backend,
  type Capability,
  type CustomImageRoute,
  type ModelKind,
} from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/shared/lib/cn";
import {
  patchAppSettings,
  requestNotificationPermission,
  useAppSettings,
  type SubmitMode,
} from "@/shared/settings/app-settings";
import {
  BUILTIN_ROUTE_DEFS,
  draftCustomRoute,
  isBuiltinRouteId,
  listImageRoutes,
} from "@/transport/image-routes";

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
  imageRouteOverrides: Record<string, string>;
};

export function SettingsView({
  backend, models, loading, error, onRefresh, onPatch, onRemove, onAdd, draft, onDraftChange,
}: {
  backend: Backend;
  models: CatalogModel[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onPatch: (changes: Partial<Backend>) => void;
  onRemove: () => void;
  onAdd: () => void;
  draft: ModelDraft | null;
  onDraftChange: (draft: ModelDraft | null) => void;
}) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-3 p-4">
      <Tabs defaultValue="backend" className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList className="self-start">
          <TabsTrigger value="backend">后端</TabsTrigger>
          <TabsTrigger value="models">模型</TabsTrigger>
          <TabsTrigger value="routes">图片路由</TabsTrigger>
          <TabsTrigger value="behavior">行为</TabsTrigger>
        </TabsList>

        <TabsContent value="backend" className="min-h-0 flex-1 overflow-y-auto">
          <BackendSection backend={backend} onPatch={onPatch} onRemove={onRemove} onAdd={onAdd} />
        </TabsContent>
        <TabsContent value="models" className="flex min-h-0 flex-1 flex-col">
          <ModelSection
            backend={backend} models={models} loading={loading} error={error}
            onRefresh={onRefresh} onPatch={onPatch}
            draft={draft} onDraftChange={onDraftChange}
          />
        </TabsContent>
        <TabsContent value="routes" className="min-h-0 flex-1 overflow-y-auto">
          <RouteSection backend={backend} onPatch={onPatch} />
        </TabsContent>
        <TabsContent value="behavior" className="min-h-0 flex-1 overflow-y-auto">
          <BehaviorSection />
        </TabsContent>
      </Tabs>
    </div>
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

  const probe = useMutation({
    mutationFn: () => probeBackend(backend.baseURL),
    onSuccess: (result) => {
      onPatch({ capabilities: result.capabilities, flavor: result.flavor, probedAt: Date.now() });
      if (result.suspicious) toast.warning("每个端点都返回 200，八成是 catch-all 兜底，下面自己勾一下");
      else toast.success(`探到 ${result.capabilities.length} 项能力`);
    },
    onError: () => toast.error("探测失败，检查地址是否可达"),
  });

  function save(): void {
    if (!normalized) {
      toast.error("地址不能为空");
      return;
    }
    onPatch({ name: name.trim() || new URL(normalized).hostname, baseURL: normalized, apiKey });
    toast.success("已保存");
  }

  function toggleCapability(capability: Capability): void {
    onPatch({
      capabilities: backend.capabilities.includes(capability)
        ? backend.capabilities.filter((item) => item !== capability)
        : [...backend.capabilities, capability],
    });
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
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">能力</h2>
          <Button
            variant="ghost" size="sm" className="ml-auto h-8 gap-1 px-2 text-xs"
            disabled={probe.isPending || dirty} onClick={() => probe.mutate()}
          >
            {probe.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            重新探测
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {CAPABILITIES.map((capability) => {
            const on = backend.capabilities.includes(capability);
            return (
              <button
                key={capability}
                type="button"
                onClick={() => toggleCapability(capability)}
                aria-pressed={on}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {CAPABILITY_LABELS[capability]}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          决定侧边栏显示哪几个面板。探测靠的是「404 就是没这个路由」，
          会对 5 个端点各发一次空请求 —— <strong className="font-medium">别反复点</strong>，
          密集的小请求会被上游当成测活。探错了直接在上面手动勾。
          {dirty ? " 上面的改动还没保存，先保存再探。" : ""}
          {backend.probedAt ? ` 上次探测：${new Date(backend.probedAt).toLocaleString()}。` : ""}
        </p>
      </section>
    </div>
  );
}

/* ── 模型 ─────────────────────────────────────────────────────────── */

function ModelSection({
  backend, models, loading, error, onRefresh, onPatch, draft, onDraftChange,
}: {
  backend: Backend;
  models: CatalogModel[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
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
        <Button variant="ghost" size="icon" className="ml-auto size-8" onClick={onRefresh} disabled={loading} aria-label="刷新模型列表">
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
              {dirty ? "改动还没生效，点保存。" : "勾好后点保存。聊天时的模型选择器只显示保存过的。"}
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
            可用变量：<code className="rounded bg-secondary px-1 py-0.5 font-mono">model prompt n size aspectRatio quality responseFormat</code>
            （下划线写法同样认）。面板上只会显示模板真正用到的那几个参数控件。
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
    </section>
  );
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
