import {
  ArrowUp,
  Download,
  ExternalLink,
  FileVideo,
  Loader2,
  Paperclip,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import type { CatalogModel } from "@/backends/model-catalog";
import type { Backend } from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/features/console/model-picker";
import { cn } from "@/shared/lib/cn";
import { isAbortError } from "@/transport/errors";
import {
  createVideoGeneration,
  editVideoGeneration,
  extendVideoGeneration,
  pollVideoGeneration,
  uploadVideoInput,
  type VideoGenerationStatus,
  type VideoSource,
} from "@/transport/videos";

type VideoOperation = "generate" | "edit" | "extend";
type SelectOption = { value: string; label: string };

const VIDEO_OPERATIONS: Array<{ value: VideoOperation; label: string }> = [
  { value: "generate", label: "生成" },
  { value: "edit", label: "编辑" },
  { value: "extend", label: "延长" },
];
const VIDEO_DURATIONS = ["4", "6", "8", "10"].map((value) => ({ value, label: `${value}秒` }));
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"].map((value) => ({ value, label: value }));
const VIDEO_RESOLUTIONS = ["480p", "720p"].map((value) => ({ value, label: value }));
const EXTEND_DURATIONS: SelectOption[] = [
  { value: "default", label: "默认时长" },
  ...Array.from({ length: 9 }, (_, index) => {
    const value = String(index + 2);
    return { value, label: `${value}秒` };
  }),
];

type RunPhase = "idle" | "uploading" | "submitting" | "polling" | "done" | "failed" | "cancelled";

type RunState = {
  phase: RunPhase;
  requestId?: string;
  status?: VideoGenerationStatus;
  error?: string;
};

export function VideoPanel({
  backend,
  models,
  onManage,
}: {
  backend: Backend;
  /** 可以传全部已保存模型，面板会再筛出 video。 */
  models: CatalogModel[];
  onManage: () => void;
}) {
  const videoModels = useMemo(() => models.filter((item) => item.saved && item.kind === "video"), [models]);
  const [selectedModel, setSelectedModel] = useState(videoModels[0]?.id ?? "");
  const model = videoModels.some((item) => item.id === selectedModel) ? selectedModel : videoModels[0]?.id ?? "";

  const [operation, setOperation] = useState<VideoOperation>("generate");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("6");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [resolution, setResolution] = useState("720p");
  const [extendDuration, setExtendDuration] = useState("default");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePreview, setSourcePreview] = useState("");
  const [formError, setFormError] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runSequenceRef = useRef(0);

  const busy = run.phase === "uploading" || run.phase === "submitting" || run.phase === "polling";
  const canSubmit = Boolean(prompt.trim() && model && (operation === "generate" || sourceFile));

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => {
    if (sourcePreview) URL.revokeObjectURL(sourcePreview);
  }, [sourcePreview]);

  function changeOperation(next: VideoOperation) {
    if (busy || next === operation) return;
    setOperation(next);
    setFormError("");
    setRun({ phase: "idle" });
    const expectedKind = sourceKindForOperation(next);
    if (sourceFile && sourceKind(sourceFile) !== expectedKind) clearSource();
  }

  function selectSource(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const kind = sourceKind(file);
    if (!kind) {
      setFormError("只支持图片或视频文件");
      return;
    }
    const expectedKind = sourceKindForOperation(operation);
    if (kind !== expectedKind) {
      setFormError(operation === "generate" ? "生成模式只接受源图片" : `${operationLabel(operation)}模式必须使用源视频`);
      return;
    }
    setFormError("");
    setSourceFile(file);
    setSourcePreview(URL.createObjectURL(file));
  }

  function clearSource() {
    setSourceFile(null);
    setSourcePreview("");
  }

  function cancel() {
    const controller = abortRef.current;
    if (!controller) return;
    controller.abort();
    abortRef.current = null;
    setRun((current) => ({ ...current, phase: "cancelled", error: undefined }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (busy || !model) return;
    if (!text) {
      setFormError("请输入视频描述");
      return;
    }
    if (operation !== "generate" && !sourceFile) {
      setFormError(`请先添加要${operationLabel(operation)}的源视频`);
      return;
    }
    setFormError("");
    void runVideoTask(text);
  }

  async function runVideoTask(text: string) {
    const sequence = runSequenceRef.current + 1;
    runSequenceRef.current = sequence;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const update = (next: RunState | ((current: RunState) => RunState)) => {
      if (runSequenceRef.current !== sequence) return;
      setRun(next);
    };

    update({ phase: sourceFile ? "uploading" : "submitting" });

    try {
      let source: VideoSource | undefined;
      if (sourceFile) {
        const kind = sourceKind(sourceFile);
        if (!kind) throw new Error("只支持图片或视频文件");
        const uploaded = await uploadVideoInput(sourceFile, controller.signal);
        source = { url: uploaded.url, kind, contentType: uploaded.contentType };
        update({ phase: "submitting" });
      }

      const commonInput = {
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        model,
        prompt: text,
        signal: controller.signal,
      };
      const job = operation === "generate"
        ? await createVideoGeneration({
            ...commonInput,
            duration: Number(duration),
            aspectRatio,
            resolution,
            source,
          })
        : operation === "edit"
          ? await editVideoGeneration({ ...commonInput, source: requireUploadedSource(source, "video") })
          : await extendVideoGeneration({
              ...commonInput,
              source: requireUploadedSource(source, "video"),
              duration: extendDuration === "default" ? undefined : Number(extendDuration),
            });

      update(runStateFromStatus(job.status, job.requestId));
      if (job.status.status !== "pending") return;
      if (!job.requestId) throw new Error("上游没有返回可轮询的视频任务 ID");

      const finalStatus = await pollVideoGeneration({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        requestId: job.requestId,
        initial: job.status,
        onUpdate: (status) => update(runStateFromStatus(status, job.requestId)),
        signal: controller.signal,
      });
      update(runStateFromStatus(finalStatus, job.requestId));
    } catch (caught) {
      if (controller.signal.aborted || isAbortError(caught)) {
        update((current) => ({ ...current, phase: "cancelled", error: undefined }));
      } else {
        update((current) => ({
          ...current,
          phase: "failed",
          error: caught instanceof Error ? caught.message : String(caught),
        }));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
        <OperationSegment value={operation} onChange={changeOperation} disabled={busy} />
        <ModelPicker
          models={videoModels}
          value={model}
          onChange={setSelectedModel}
          onManage={onManage}
          disabled={busy}
        />
        {operation === "generate" ? (
          <>
            <CompactSelect label="时长" value={duration} options={VIDEO_DURATIONS} onChange={setDuration} disabled={busy} />
            <CompactSelect label="画面比例" value={aspectRatio} options={VIDEO_ASPECT_RATIOS} onChange={setAspectRatio} disabled={busy} />
            <CompactSelect label="清晰度" value={resolution} options={VIDEO_RESOLUTIONS} onChange={setResolution} disabled={busy} />
          </>
        ) : null}
        {operation === "extend" ? (
          <CompactSelect label="延长时长" value={extendDuration} options={EXTEND_DURATIONS} onChange={setExtendDuration} disabled={busy} />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-3 py-6 sm:px-6">
          <VideoWorkspace run={run} operation={operation} onManage={onManage} hasModels={videoModels.length > 0} />
        </div>
      </div>

      <form onSubmit={submit} className="shrink-0 px-3 pb-3">
        <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border bg-card transition-colors focus-within:border-border-hover">
          {sourceFile ? (
            <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
              <SourcePreview file={sourceFile} url={sourcePreview} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{sourceFile.name}</p>
                <p className="text-[11px] text-muted-foreground">{sourceKind(sourceFile) === "image" ? "源图" : "源视频"} · {formatBytes(sourceFile.size)}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={clearSource} disabled={busy} aria-label="移除源文件">
                <X className="size-3.5" />
              </Button>
            </div>
          ) : null}

          <Textarea
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); if (formError) setFormError(""); }}
            placeholder={videoModels.length === 0 ? "先去设置里保存视频模型" : promptPlaceholder(operation)}
            rows={3}
            disabled={videoModels.length === 0 || busy}
            className="min-h-24 resize-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0"
          />

          <div className="flex items-center justify-between gap-2 px-3 pb-3">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={selectSource}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("h-8 gap-1.5 px-2 font-normal", sourceFile && "bg-accent")}
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                <Paperclip className="size-3.5" />
                {sourceFile ? (operation === "generate" ? "更换源图" : "更换源视频") : sourceButtonLabel(operation)}
              </Button>
            </div>

            {busy ? (
              <Button
                type="button"
                size="icon"
                className="size-9 shrink-0"
                onClick={cancel}
                aria-label={`停止${operationLabel(operation)}`}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="size-9 shrink-0"
                disabled={!canSubmit}
                aria-label={`${operationLabel(operation)}视频`}
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
        {formError ? <p className="mx-auto mt-1 max-w-3xl px-2 text-[11px] text-destructive">{formError}</p> : null}
      </form>
    </div>
  );
}

function OperationSegment({
  value,
  onChange,
  disabled,
}: {
  value: VideoOperation;
  onChange: (value: VideoOperation) => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-md bg-secondary p-0.5" role="group" aria-label="视频操作">
      {VIDEO_OPERATIONS.map((operation) => (
        <button
          key={operation.value}
          type="button"
          aria-pressed={value === operation.value}
          disabled={disabled}
          onClick={() => onChange(operation.value)}
          className={cn(
            "h-7 rounded-sm px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            value === operation.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {operation.label}
        </button>
      ))}
    </div>
  );
}

function CompactSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className="h-8 w-auto min-w-20 gap-1 rounded-full bg-transparent px-2.5 shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function VideoWorkspace({
  run,
  operation,
  hasModels,
  onManage,
}: {
  run: RunState;
  operation: VideoOperation;
  hasModels: boolean;
  onManage: () => void;
}) {
  if (run.phase === "idle") {
    if (!hasModels) {
      return (
        <div className="py-20 text-center text-sm text-muted-foreground">
          <p>还没有保存视频模型</p>
          <button type="button" onClick={onManage} className="mt-2 underline underline-offset-4 hover:text-foreground">去设置里挑几个</button>
        </div>
      );
    }
    return <p className="py-20 text-center text-sm text-muted-foreground">{emptyStateLabel(operation)}</p>;
  }

  const status = run.status;
  const progress = status?.progress ?? 0;
  const error = run.error || status?.error?.message;
  const running = run.phase === "uploading" || run.phase === "submitting" || run.phase === "polling";

  return (
    <div className="w-full space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{phaseLabel(run.phase, operation, status)}</p>
          <p className="mt-1 break-all font-mono text-xs">{run.requestId || (run.phase === "done" ? "即时结果" : "等待任务 ID")}</p>
        </div>
        {status?.model ? <span className="max-w-full truncate rounded bg-secondary px-2 py-1 font-mono text-[11px] text-muted-foreground">{status.model}</span> : null}
      </div>

      {status || run.phase === "polling" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">进度</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}

      {running ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {run.phase === "uploading"
            ? "正在上传源文件"
            : run.phase === "submitting"
              ? "正在提交任务"
              : `正在轮询${operationLabel(operation)}状态`}
        </div>
      ) : null}

      {run.phase === "cancelled" ? (
        <p className="text-xs text-muted-foreground">已停止等待。任务已经提交时，服务端可能仍会继续生成。</p>
      ) : null}

      {run.phase === "failed" ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap">{error || `${operationLabel(operation)}视频失败`}</p>
        </div>
      ) : null}

      {run.phase === "done" && status?.video ? (
        <div className="space-y-3">
          <video src={status.video.url} controls preload="metadata" className="max-h-[62vh] w-full rounded-lg bg-black" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{status.video.duration ? `${status.video.duration} 秒` : ""}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={status.video.url} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" />打开</a>
              </Button>
              <Button variant="secondary" size="sm" asChild>
                <a href={status.video.url} download={downloadName(run.requestId)}><Download className="size-3.5" />下载</a>
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {run.phase === "done" && !status?.video ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>任务已完成，但响应里没有可播放的视频 URL。</p>
        </div>
      ) : null}
    </div>
  );
}

function SourcePreview({ file, url }: { file: File; url: string }) {
  if (sourceKind(file) === "image") {
    return <img src={url} alt="源图预览" className="size-10 shrink-0 rounded-md bg-secondary object-cover" />;
  }
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
      <FileVideo className="size-4" />
    </span>
  );
}

function runStateFromStatus(status: VideoGenerationStatus, fallbackId: string): RunState {
  return {
    phase: status.status === "done" ? "done" : status.status === "failed" ? "failed" : "polling",
    requestId: status.requestId || fallbackId || undefined,
    status,
    error: status.status === "failed" ? status.error?.message : undefined,
  };
}

function phaseLabel(phase: RunPhase, operation: VideoOperation, status?: VideoGenerationStatus): string {
  if (phase === "uploading") return "上传源文件";
  if (phase === "submitting") return "提交任务";
  if (phase === "polling") return status?.rawStatus ? `${operationLabel(operation)}中 · ${status.rawStatus}` : `${operationLabel(operation)}中`;
  if (phase === "done") return `${operationLabel(operation)}完成`;
  if (phase === "failed") return status?.rawStatus ? `${operationLabel(operation)}失败 · ${status.rawStatus}` : `${operationLabel(operation)}失败`;
  if (phase === "cancelled") return "已停止";
  return "等待生成";
}

function sourceKindForOperation(operation: VideoOperation): VideoSource["kind"] {
  return operation === "generate" ? "image" : "video";
}

function requireUploadedSource(source: VideoSource | undefined, expectedKind: VideoSource["kind"]): VideoSource {
  if (!source || source.kind !== expectedKind || !source.url.trim()) {
    throw new Error(expectedKind === "video" ? "请先添加源视频" : "请先添加源图片");
  }
  return source;
}

function operationLabel(operation: VideoOperation): string {
  if (operation === "edit") return "编辑";
  if (operation === "extend") return "延长";
  return "生成";
}

function sourceButtonLabel(operation: VideoOperation): string {
  if (operation === "edit") return "添加待编辑视频";
  if (operation === "extend") return "添加待延长视频";
  return "添加源图（可选）";
}

function promptPlaceholder(operation: VideoOperation): string {
  if (operation === "edit") return "描述你想怎样编辑这段视频…";
  if (operation === "extend") return "描述你想延长出的后续画面…";
  return "描述你想生成的视频…";
}

function emptyStateLabel(operation: VideoOperation): string {
  if (operation === "edit") return "添加源视频并输入描述，开始编辑";
  if (operation === "extend") return "添加源视频并输入描述，开始延长";
  return "输入描述开始生成视频";
}

function sourceKind(file: File): VideoSource["kind"] | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (/\.(mp4|webm|mov)$/.test(name)) return "video";
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadName(requestId?: string): string {
  const safe = (requestId || "generated").replaceAll(/[^a-zA-Z0-9_-]+/g, "-");
  return `${safe || "generated"}.mp4`;
}
