import {
  ArrowUp,
  Download,
  ExternalLink,
  Image as ImageIcon,
  ImagePlus,
  Images,
  Loader2,
  Maximize2,
  Pencil,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";

import type { CatalogModel } from "@/backends/model-catalog";
import type { Backend } from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ModelPicker } from "@/features/console/model-picker";
import { ImageViewer } from "@/features/image/image-viewer";
import { GenerationHistory } from "@/features/history/generation-history";
import { hydrateAssets, toAsset, type GenerationRecord } from "@/features/history/generation-store";
import { useGenerationHistory } from "@/features/history/use-generation-history";
import {
  generateImages,
  type ImageResponseFormat,
} from "@/transport/images";
import { imageRouteFor, imageRouteSupportsInputImages, routeVariables } from "@/transport/image-routes";
import { isAbortError } from "@/transport/errors";
import { isImageInputFile, readImageInputFile } from "@/shared/image-input";
import { cn } from "@/shared/lib/cn";
import { notifyTaskDone, shouldSubmitOnKey, useAppSettings } from "@/shared/settings/app-settings";
import type { ImageResult } from "@/transport/types";

type DimensionMode = "size" | "aspect_ratio";
type Count = "1" | "2" | "3" | "4";
type Quality = "default" | "auto" | "low" | "medium" | "high" | "standard" | "hd";
type ReferenceImage = { id: string; name: string; size: number; url: string };

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

const COUNTS: Array<SelectOption<Count>> = [
  { value: "1", label: "1 张" },
  { value: "2", label: "2 张" },
  { value: "3", label: "3 张" },
  { value: "4", label: "4 张" },
];
const DIMENSION_MODES: Array<SelectOption<DimensionMode>> = [
  { value: "size", label: "按尺寸" },
  { value: "aspect_ratio", label: "按比例" },
];
const SIZES: Array<SelectOption<string>> = [
  { value: "auto", label: "自适应" },
  { value: "1024x1024", label: "1024x1024" },
  { value: "1536x1024", label: "1536x1024" },
  { value: "1024x1536", label: "1024x1536" },
  { value: "1792x1024", label: "1792x1024" },
  { value: "1024x1792", label: "1024x1792" },
];
const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const QUALITIES: Array<SelectOption<Quality>> = [
  { value: "default", label: "默认质量" },
  { value: "auto", label: "auto" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "standard", label: "standard" },
  { value: "hd", label: "hd" },
];
const RESPONSE_FORMATS: Array<SelectOption<ImageResponseFormat>> = [
  { value: "url", label: "URL" },
  { value: "b64_json", label: "Base64" },
];

export function ImagePanel({
  backend,
  models,
  onManage,
}: {
  backend: Backend;
  /** 可以传完整目录或已保存目录；面板只会展示保存过的 image 模型。 */
  models: CatalogModel[];
  onManage: () => void;
}) {
  const imageModels = useMemo(
    () => models.filter((item) => item.saved && item.kind === "image"),
    [models],
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<Count>("1");
  const [dimensionMode, setDimensionMode] = useState<DimensionMode>("size");
  const [size, setSize] = useState("auto");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [quality, setQuality] = useState<Quality>("default");
  const [responseFormat, setResponseFormat] = useState<ImageResponseFormat>("url");
  const [images, setImages] = useState<ImageResult[]>([]);
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [readingImages, setReadingImages] = useState(0);
  const [draggingImages, setDraggingImages] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const readingImageStatsRef = useRef({ count: 0, bytes: 0 });
  const imageReadEpochRef = useRef(0);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settings = useAppSettings();

  const history = useGenerationHistory(backend.id, "image");
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  // 打开历史记录时造的对象 URL 要释放，换一条或卸载时调
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => () => releaseRef.current?.(), []);

  function showRecord(record: GenerationRecord): void {
    setPreviewIndex(null);
    imageReadEpochRef.current += 1;
    readingImageStatsRef.current = { count: 0, bytes: 0 };
    setReadingImages(0);
    setDraggingImages(false);
    releaseRef.current?.();
    const { urls, release } = hydrateAssets(record);
    releaseRef.current = release;
    setImages(urls.map((item) => ({ url: item.url, revisedPrompt: item.note })));
    setActiveRecordId(record.id);
    setError("");
    setReferenceImages([]);
    setPrompt(typeof record.params?.prompt === "string" ? record.params.prompt : record.title);
    if (imageModels.some((item) => item.id === record.model)) setSelectedModel(record.model);
  }

  function startNew(): void {
    if (pending) return;
    setPreviewIndex(null);
    releaseRef.current?.();
    releaseRef.current = null;
    setSelectedModel(imageModels[0]?.id ?? "");
    setPrompt("");
    setCount("1");
    setDimensionMode("size");
    setSize("auto");
    setAspectRatio("1:1");
    setQuality("default");
    setResponseFormat("url");
    setImages([]);
    setReferenceImages([]);
    setReadingImages(0);
    setDraggingImages(false);
    imageReadEpochRef.current += 1;
    dragDepthRef.current = 0;
    readingImageStatsRef.current = { count: 0, bytes: 0 };
    setError("");
    setActiveRecordId(null);
  }

  const model = imageModels.some((item) => item.id === selectedModel)
    ? selectedModel
    : imageModels[0]?.id ?? "";

  /**
   * 这条模型走的路由到底会发哪些参数。
   * 走 chat/completions 时尺寸、质量、返回格式根本不会被发出去，
   * 还把控件摆在那里就是骗人。
   */
  const selectedRoute = useMemo(
    () => (model ? imageRouteFor(backend, model) : null),
    [backend, model],
  );
  const routeVars = useMemo(
    () => (selectedRoute ? routeVariables(selectedRoute) : new Set<string>()),
    [selectedRoute],
  );
  const canUseReferenceImages = selectedRoute ? imageRouteSupportsInputImages(selectedRoute) : false;
  const canSize = routeVars.has("size");
  const canAspect = routeVars.has("aspectRatio");
  const effectiveDimension: DimensionMode = canSize && canAspect ? dimensionMode : canSize ? "size" : "aspect_ratio";

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!canUseReferenceImages) {
      imageReadEpochRef.current += 1;
      readingImageStatsRef.current = { count: 0, bytes: 0 };
      setReadingImages(0);
      setDraggingImages(false);
      setReferenceImages([]);
    }
  }, [canUseReferenceImages]);

  const addImageFiles = useCallback((incoming: FileList | File[]) => {
    if (pending || !canUseReferenceImages) return;
    const files = Array.from(incoming);
    if (files.length === 0) return;

    const imageFiles = files.filter(isImageInputFile);
    if (imageFiles.length < files.length) toast.error("只支持图片文件，其他文件已忽略");

    const reading = readingImageStatsRef.current;
    const available = MAX_REFERENCE_IMAGES - referenceImages.length - reading.count;
    if (available <= 0) {
      toast.error(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图`);
      return;
    }

    const selected = imageFiles.slice(0, available);
    if (imageFiles.length > available) toast.error(`最多添加 ${MAX_REFERENCE_IMAGES} 张参考图，多余的已忽略`);
    const withinPerImageLimit = selected.filter((file) => file.size <= MAX_REFERENCE_IMAGE_BYTES);
    if (withinPerImageLimit.length < selected.length) toast.error("单张图片不能超过 10 MB，超出的已忽略");

    const existingBytes = referenceImages.reduce((total, image) => total + image.size, 0);
    let selectedBytes = 0;
    let totalLimitReached = false;
    const valid = withinPerImageLimit.filter((file) => {
      if (existingBytes + reading.bytes + selectedBytes + file.size > MAX_REFERENCE_IMAGE_TOTAL_BYTES) {
        totalLimitReached = true;
        return false;
      }
      selectedBytes += file.size;
      return true;
    });
    if (totalLimitReached) toast.error("参考图片合计不能超过 20 MB，超出的已忽略");
    if (valid.length === 0) return;

    const readEpoch = imageReadEpochRef.current;
    readingImageStatsRef.current = { count: reading.count + valid.length, bytes: reading.bytes + selectedBytes };
    setReadingImages((current) => current + valid.length);
    void Promise.allSettled(valid.map((file) => readImageInputFile(file, createReferenceId()))).then((results) => {
      if (imageReadEpochRef.current !== readEpoch) return;
      const loaded = results.flatMap((result) => result.status === "fulfilled"
        ? [{
            id: result.value.id,
            name: result.value.name,
            size: result.value.size,
            url: result.value.dataUrl,
          }]
        : []);
      if (loaded.length > 0) {
        setReferenceImages((current) => [...current, ...loaded].slice(0, MAX_REFERENCE_IMAGES));
      }
      if (loaded.length < valid.length) toast.error("有图片读取失败，请重试");
    }).finally(() => {
      if (imageReadEpochRef.current !== readEpoch) return;
      const current = readingImageStatsRef.current;
      readingImageStatsRef.current = {
        count: Math.max(0, current.count - valid.length),
        bytes: Math.max(0, current.bytes - selectedBytes),
      };
      setReadingImages((current) => Math.max(0, current - valid.length));
    });
  }, [canUseReferenceImages, pending, referenceImages]);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    if (!canUseReferenceImages) {
      toast.error("当前图片路由没有配置参考图输入");
      return;
    }
    if (pending) {
      toast.error("图片生成完成后再添加参考图");
      return;
    }
    addImageFiles(files);
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (canUseReferenceImages && !pending) setDraggingImages(true);
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingImages(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDraggingImages(false);
    if (event.dataTransfer.files.length > 0) addImageFiles(event.dataTransfer.files);
  }

  function useImageAsReference(image: ImageResult, index: number): void {
    imageReadEpochRef.current += 1;
    readingImageStatsRef.current = { count: 0, bytes: 0 };
    setReadingImages(0);
    setReferenceImages([{
      id: createReferenceId(),
      name: `生成图片 ${index + 1}`,
      size: 0,
      url: image.url,
    }]);
    setError("");
  }

  async function startGeneration(): Promise<void> {
    const text = prompt.trim();
    if (!text || !model || abortRef.current || readingImages > 0) return;

    const controller = new AbortController();
    const previousImages = images;
    const wasEditing = referenceImages.length > 0;
    abortRef.current = controller;
    setPending(true);
    setError("");
    setPreviewIndex(null);
    if (settings.clearInputAfterSubmit) setPrompt("");

    try {
      const result = await generateImages({
        backend,
        model,
        prompt: text,
        inputImages: referenceImages.map((image) => image.url),
        n: Number(count),
        ...(effectiveDimension === "size" ? { size } : { aspectRatio }),
        ...(quality === "default" ? {} : { quality }),
        responseFormat,
        idleTimeoutMs: settings.imageTimeoutSeconds * 1000,
        signal: controller.signal,
        onUpdate: setImages,
      });
      setImages(result);
      releaseRef.current?.();
      releaseRef.current = null;
      if (wasEditing && result.length === 1) {
        setReferenceImages([{
          id: createReferenceId(),
          name: "上一版生成结果",
          size: 0,
          url: result[0].url,
        }]);
      } else if (wasEditing) {
        setReferenceImages([]);
      }
      notifyTaskDone("图片生成完成", `${result.length} 张 · ${model}`);

      const assets = await Promise.all(result.map((image) => toAsset(image.url, image.revisedPrompt)));
      const saved = history.record({
        model,
        title: text,
        assets,
        params: {
          prompt: text,
          count, size, aspectRatio, quality, responseFormat,
          dimensionMode: effectiveDimension,
        },
      });
      setActiveRecordId(saved.id);
    } catch (caught) {
      setImages(previousImages);
      if (!isAbortError(caught)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPending(false);
      }
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void startGeneration();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (shouldSubmitOnKey(event, settings.submitMode)) {
      event.preventDefault();
      void startGeneration();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <ModelPicker
          models={imageModels}
          value={model}
          onChange={setSelectedModel}
          onManage={onManage}
          disabled={pending}
        />
      </div>

      <GenerationHistory
        records={history.records}
        activeId={activeRecordId}
        onNew={startNew}
        newLabel="新图片"
        newDisabled={pending}
        busy={pending}
        onOpen={showRecord}
        onDelete={(id) => {
          history.remove(id);
          if (id === activeRecordId) setActiveRecordId(null);
        }}
        onClear={() => { history.clear(); setActiveRecordId(null); }}
        emptyHint="生成过的图片会存在这里，刷新也不丢。"
      />

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={pending}>
        <div className="mx-auto flex min-h-full max-w-5xl flex-col px-3 py-4 sm:px-5">
          {imageModels.length === 0 ? (
            <EmptyState onManage={onManage} />
          ) : images.length === 0 && pending ? (
            <LoadingState />
          ) : images.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center text-sm text-muted-foreground">
              <ImageIcon className="mb-3 size-6" />
              <p>描述你想生成的画面</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                  <Loader2 className="size-3.5 animate-spin" />
                  {referenceImages.length > 0 ? "正在生成修改版本…" : "正在生成新图片…"}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-live="polite">
                {images.map((image, index) => (
                  <ImageCard
                    key={`${image.url.slice(0, 80)}-${index}`}
                    image={image}
                    index={index}
                    onPreview={(trigger) => {
                      previewTriggerRef.current = trigger;
                      setPreviewIndex(index);
                    }}
                    onEdit={() => useImageAsReference(image, index)}
                    editDisabled={pending || !canUseReferenceImages}
                  />
                ))}
              </div>
            </div>
          )}

          {error ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          ) : null}
        </div>
      </div>

      <form
        onSubmit={submit}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="shrink-0 px-3 pb-3"
      >
        <div className={cn(
          "relative mx-auto max-w-4xl overflow-hidden rounded-2xl border bg-card transition-colors focus-within:border-foreground/20",
          draggingImages && "border-primary bg-primary/5",
        )}>
          {draggingImages ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-card/90 text-xs text-primary">
              <ImagePlus className="size-4" />
              松开以上传参考图
            </div>
          ) : null}

          {referenceImages.length > 0 ? (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {referenceImages.map((image) => (
                <ReferenceImagePreview
                  key={image.id}
                  image={image}
                  onRemove={() => setReferenceImages((current) => current.filter((item) => item.id !== image.id))}
                  disabled={pending}
                />
              ))}
            </div>
          ) : null}

          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            placeholder={imageModels.length === 0
              ? "先去设置里保存图片模型"
              : referenceImages.length > 0
                ? "描述想怎样修改参考图…"
                : "描述画面、风格、构图与细节…"}
            disabled={imageModels.length === 0}
            rows={3}
            className="min-h-20 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0"
          />

          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pb-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => {
                  if (event.target.files) addImageFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="添加参考图"
                    disabled={!model || pending || !canUseReferenceImages}
                    className="size-8 shrink-0 rounded-full text-muted-foreground"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {readingImages > 0
                      ? <Loader2 className="size-4 animate-spin" />
                      : <ImagePlus className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {canUseReferenceImages ? "添加参考图" : "当前图片路由没有配置参考图输入"}
                </TooltipContent>
              </Tooltip>
              {routeVars.has("n") ? (
                <CompactSelect
                  value={count}
                  options={COUNTS}
                  onChange={setCount}
                  ariaLabel="生成数量"
                  disabled={pending}
                  icon={<Images className="size-3.5" />}
                />
              ) : null}
              {canSize && canAspect ? (
                <CompactSelect
                  value={dimensionMode}
                  options={DIMENSION_MODES}
                  onChange={setDimensionMode}
                  ariaLabel="尺寸参数类型"
                  disabled={pending}
                />
              ) : null}
              {effectiveDimension === "size" && canSize ? (
                <CompactSelect
                  value={size}
                  options={SIZES}
                  onChange={setSize}
                  ariaLabel="图片尺寸"
                  disabled={pending}
                />
              ) : null}
              {effectiveDimension === "aspect_ratio" && canAspect ? (
                <CompactSelect
                  value={aspectRatio}
                  options={ASPECT_RATIOS.map((value) => ({ value, label: value }))}
                  onChange={setAspectRatio}
                  ariaLabel="图片比例"
                  disabled={pending}
                />
              ) : null}
              {routeVars.has("quality") ? (
                <CompactSelect
                  value={quality}
                  options={QUALITIES}
                  onChange={setQuality}
                  ariaLabel="图片质量"
                  disabled={pending}
                />
              ) : null}
              {routeVars.has("responseFormat") ? (
                <CompactSelect
                  value={responseFormat}
                  options={RESPONSE_FORMATS}
                  onChange={setResponseFormat}
                  ariaLabel="返回格式"
                  disabled={pending}
                />
              ) : null}
            </div>

            {pending ? (
              <Button type="button" size="icon" className="ml-auto size-9 shrink-0 rounded-full" onClick={stop} aria-label="停止生成">
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="ml-auto size-9 shrink-0 rounded-full"
                disabled={!prompt.trim() || !model || readingImages > 0}
                aria-label={readingImages > 0 ? "正在读取参考图" : "生成图片"}
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </form>

      {previewIndex !== null && images[previewIndex] ? (
        <ImageViewer
          image={images[previewIndex]}
          index={previewIndex}
          total={images.length}
          onPrevious={() => setPreviewIndex((current) => current === null ? null : Math.max(0, current - 1))}
          onNext={() => setPreviewIndex((current) => current === null ? null : Math.min(images.length - 1, current + 1))}
          onClose={() => setPreviewIndex(null)}
          returnFocus={previewTriggerRef.current}
        />
      ) : null}
    </div>
  );
}

function EmptyState({ onManage }: { onManage: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-center text-sm text-muted-foreground">
      <p>还没有保存图片模型</p>
      <button type="button" onClick={onManage} className="mt-2 underline underline-offset-4 hover:text-foreground">
        去设置里挑几个
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-20 text-sm text-muted-foreground" aria-live="polite">
      <Loader2 className="mb-3 size-5 animate-spin" />
      <p>正在生成图片…</p>
    </div>
  );
}

function ImageCard({
  image,
  index,
  onPreview,
  onEdit,
  editDisabled,
}: {
  image: ImageResult;
  index: number;
  onPreview: (trigger: HTMLButtonElement) => void;
  onEdit: () => void;
  editDisabled: boolean;
}) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border bg-card p-2">
      <button
        type="button"
        aria-label={`放大查看图片 ${index + 1}`}
        onClick={(event) => onPreview(event.currentTarget)}
        className="group relative flex min-h-52 w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={image.url}
          alt={`生成图片 ${index + 1}`}
          className="pointer-events-none max-h-[65vh] w-full object-contain"
          loading="lazy"
        />
        <span className="pointer-events-none absolute right-2 top-2 flex size-8 items-center justify-center rounded-md bg-black/65 text-white shadow-sm transition-colors group-hover:bg-black/80" aria-hidden="true">
          <Maximize2 className="size-4" />
        </span>
      </button>
      <figcaption className="flex min-w-0 items-center gap-2 px-1 pt-2">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={image.revisedPrompt || `图片 ${index + 1}`}
        >
          {image.revisedPrompt || `图片 ${index + 1}`}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`基于图片 ${index + 1} 修改`}
              disabled={editDisabled}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>基于此图修改</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" asChild>
          <a href={image.url} download={`generated-image-${index + 1}.${imageExtension(image.url)}`} aria-label={`下载图片 ${index + 1}`}>
            <Download className="size-3.5" />
          </a>
        </Button>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" asChild>
          <a href={image.url} target="_blank" rel="noreferrer" aria-label={`打开图片 ${index + 1}`}>
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </figcaption>
    </figure>
  );
}

function ReferenceImagePreview({
  image,
  onRemove,
  disabled,
}: {
  image: ReferenceImage;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div className="group/image relative size-16 shrink-0 overflow-hidden rounded-md border bg-secondary" title={image.name}>
      <img src={image.url} alt={image.name} className="size-full object-cover" />
      <button
        type="button"
        aria-label={`移除 ${image.name}`}
        disabled={disabled}
        className="absolute right-0.5 top-0.5 flex size-7 items-center justify-center rounded bg-black/70 text-white opacity-90 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
        onClick={(event) => { event.stopPropagation(); onRemove(); }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

type SelectOption<T extends string> = { value: T; label: string };

function CompactSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  icon,
}: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-auto min-w-0 gap-1.5 rounded-full bg-secondary/70 px-2.5 shadow-none">
        {icon}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function imageExtension(url: string): string {
  const dataMime = /^data:image\/([^;,]+)/i.exec(url)?.[1]?.toLowerCase();
  if (dataMime === "jpeg") return "jpg";
  if (dataMime && /^[a-z0-9]+$/.test(dataMime)) return dataMime;
  try {
    const extension = new URL(url, "http://localhost").pathname.split(".").pop()?.toLowerCase();
    if (extension && /^(?:png|jpe?g|webp|gif|avif)$/.test(extension)) {
      return extension === "jpeg" ? "jpg" : extension;
    }
  } catch {
    // URL 不可解析时用 png 作为通用下载扩展名。
  }
  return "png";
}

function createReferenceId(): string {
  return `ref_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
