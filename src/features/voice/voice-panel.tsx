import {
  AudioLines,
  Download,
  FileAudio,
  Loader2,
  Mic,
  RefreshCw,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { CatalogModel } from "@/backends/model-catalog";
import type { Backend } from "@/backends/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { isAbortError } from "@/transport/errors";
import {
  listVoices,
  releaseSpeechAudio,
  synthesizeSpeech,
  transcribeSpeech,
  type SpeechAudioResult,
  type TranscriptionResult,
  type VoiceInfo,
} from "@/transport/voice";

type VoiceMode = "tts" | "stt";
type ActiveRequest = VoiceMode | null;
type OutputFormat = "auto" | "mp3" | "wav" | "opus";

/** 实测上游约束：超出这个区间返回 400 `speed must be between 0.7 and 1.5`。 */
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.5;

/** 实测可用的编码；aac 和 flac 上游一律 422，所以不放进选项里。 */
const OUTPUT_FORMATS = ["mp3", "wav", "opus"] as const;

const LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
] as const;

export type VoicePanelProps = {
  backend: Backend;
  models: CatalogModel[];
  onManage?: () => void;
};

export function VoicePanel({ backend, models, onManage }: VoicePanelProps) {
  const knownCapabilities = backend.capabilities.length > 0;
  const isGrok = backend.flavor === "grok2api";
  const hasTTS = isGrok && (!knownCapabilities || backend.capabilities.includes("tts"));
  const hasSTT = isGrok && (!knownCapabilities || backend.capabilities.includes("stt"));
  const [mode, setMode] = useState<VoiceMode>(() => hasTTS ? "tts" : "stt");

  const ttsModels = useMemo(
    () => models.filter((model) => model.saved && model.kind === "tts"),
    [models],
  );
  const sttModels = useMemo(
    () => models.filter((model) => model.saved && model.kind === "stt"),
    [models],
  );

  const [ttsModel, setTTSModel] = useState(ttsModels[0]?.id ?? "");
  const [sttModel, setSTTModel] = useState(sttModels[0]?.id ?? "");
  const [text, setText] = useState("");
  const [language, setLanguage] = useState("zh");
  const [speed, setSpeed] = useState("1");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("auto");
  const [withTimestamps, setWithTimestamps] = useState(false);
  const [voiceId, setVoiceId] = useState("eve");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState("");
  const [voiceReload, setVoiceReload] = useState(0);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [filePreviewURL, setFilePreviewURL] = useState("");
  const [sttLanguage, setSTTLanguage] = useState("auto");
  const [ttsResult, setTTSResult] = useState<SpeechAudioResult | null>(null);
  const [sttResult, setSTTResult] = useState<TranscriptionResult | null>(null);
  const [activeRequest, setActiveRequest] = useState<ActiveRequest>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const audioResultRef = useRef<SpeechAudioResult | null>(null);

  const replaceAudioResult = useCallback((next: SpeechAudioResult | null) => {
    releaseSpeechAudio(audioResultRef.current);
    audioResultRef.current = next;
    setTTSResult(next);
  }, []);

  useEffect(() => {
    if (!ttsModels.some((model) => model.id === ttsModel)) setTTSModel(ttsModels[0]?.id ?? "");
  }, [ttsModel, ttsModels]);

  useEffect(() => {
    if (!sttModels.some((model) => model.id === sttModel)) setSTTModel(sttModels[0]?.id ?? "");
  }, [sttModel, sttModels]);

  useEffect(() => {
    if (!hasTTS && mode === "tts" && hasSTT) setMode("stt");
    if (!hasSTT && mode === "stt" && hasTTS) setMode("tts");
  }, [hasSTT, hasTTS, mode]);

  useEffect(() => {
    if (!audioFile) {
      setFilePreviewURL("");
      return;
    }
    const url = URL.createObjectURL(audioFile);
    setFilePreviewURL(url);
    return () => URL.revokeObjectURL(url);
  }, [audioFile]);

  useEffect(() => {
    if (mode !== "tts" || !hasTTS || !ttsModel) {
      setVoices([]);
      setVoicesError("");
      setVoicesLoading(false);
      return;
    }

    const controller = new AbortController();
    setVoicesLoading(true);
    setVoicesError("");
    void listVoices({
      baseURL: backend.baseURL,
      apiKey: backend.apiKey,
      model: ttsModel,
      signal: controller.signal,
    }).then((items) => {
      setVoices(items);
      setVoiceId((current) => items.some((voice) => voice.voiceId === current) ? current : items[0]?.voiceId ?? current);
    }).catch((caught: unknown) => {
      if (isAbortError(caught)) return;
      setVoices([]);
      setVoicesError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (!controller.signal.aborted) setVoicesLoading(false);
    });

    return () => controller.abort();
  }, [backend.apiKey, backend.baseURL, hasTTS, mode, ttsModel, voiceReload]);

  useEffect(() => () => {
    requestRef.current?.abort();
    releaseSpeechAudio(audioResultRef.current);
  }, []);

  if (!isGrok) {
    return (
      <CapabilityGuide
        title="当前后端不支持语音面板"
        detail={`已连接 ${backend.name}（${backend.flavor}）。TTS/STT 需要切换到 grok2api 后端。`}
      />
    );
  }

  if (!hasTTS && !hasSTT) {
    return (
      <CapabilityGuide
        title="没有探测到语音能力"
        detail="重新探测后端能力，或确认 grok2api 已启用 /tts 与 /stt。"
        onManage={onManage}
      />
    );
  }

  const busy = activeRequest !== null;

  function changeMode(value: string) {
    const next = value as VoiceMode;
    if ((next === "tts" && !hasTTS) || (next === "stt" && !hasSTT)) return;
    requestRef.current?.abort();
    setMode(next);
    setError("");
    setStatus("");
  }

  function cancelRequest() {
    requestRef.current?.abort();
  }

  async function submitTTS(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = text.trim();
    const selectedVoice = voiceId.trim();
    const selectedLanguage = language.trim();
    const parsedSpeed = Number(speed);
    if (!prompt || !ttsModel || !selectedVoice || !selectedLanguage || busy) return;
    if (!Number.isFinite(parsedSpeed) || parsedSpeed < SPEED_MIN || parsedSpeed > SPEED_MAX) {
      setError(`语速必须在 ${SPEED_MIN} 到 ${SPEED_MAX} 之间`);
      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    setActiveRequest("tts");
    setStatus("正在合成语音…");
    setError("");
    setSTTResult(null);
    replaceAudioResult(null);

    try {
      const result = await synthesizeSpeech({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        model: ttsModel,
        text: prompt,
        voiceId: selectedVoice,
        language: selectedLanguage,
        speed: parsedSpeed,
        outputFormat: outputFormat === "auto" ? undefined : outputFormat,
        withTimestamps,
        signal: controller.signal,
      });
      replaceAudioResult(result);
      setStatus("语音已生成");
    } catch (caught) {
      if (isAbortError(caught)) setStatus("已取消语音合成");
      else {
        setStatus("");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setActiveRequest(null);
      }
    }
  }

  async function submitSTT(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!audioFile || !sttModel || busy) return;

    const controller = new AbortController();
    requestRef.current = controller;
    setActiveRequest("stt");
    setStatus("正在识别音频…");
    setError("");
    setSTTResult(null);
    replaceAudioResult(null);

    try {
      const result = await transcribeSpeech({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        model: sttModel,
        file: audioFile,
        language: sttLanguage === "auto" ? undefined : sttLanguage,
        signal: controller.signal,
      });
      setSTTResult(result);
      setStatus("转写完成");
    } catch (caught) {
      if (isAbortError(caught)) setStatus("已取消语音识别");
      else {
        setStatus("");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setActiveRequest(null);
      }
    }
  }

  function clearFile() {
    setAudioFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center border-b px-3 py-2">
        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList>
            <TabsTrigger value="tts" disabled={!hasTTS} className="gap-1.5">
              <AudioLines className="size-3.5" />文本转语音
            </TabsTrigger>
            <TabsTrigger value="stt" disabled={!hasSTT} className="gap-1.5">
              <Mic className="size-3.5" />语音转文字
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {!knownCapabilities ? (
          <span className="ml-auto text-xs text-muted-foreground">能力未确认，可直接尝试</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 pb-8">
          {mode === "tts" ? (
            ttsModels.length === 0 ? (
              <MissingModelNotice kind="TTS" onManage={onManage} />
            ) : (
              <form onSubmit={submitTTS} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <FieldLabel htmlFor="voice-text">文本</FieldLabel>
                  <Textarea
                    id="voice-text"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    placeholder="输入要朗读的文本"
                    className="min-h-36 resize-y text-sm leading-6"
                    disabled={busy}
                  />
                  <span className="self-end text-[11px] tabular-nums text-muted-foreground">{text.length} 字符</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledControl label="模型">
                    <ModelSelect models={ttsModels} value={ttsModel} onChange={setTTSModel} disabled={busy} />
                  </LabeledControl>
                  <LabeledControl label="声线">
                    {voices.length > 0 ? (
                      <Select value={voiceId} onValueChange={setVoiceId} disabled={busy || voicesLoading}>
                        <SelectTrigger><SelectValue placeholder="选择声线" /></SelectTrigger>
                        <SelectContent>
                          {voices.map((voice) => (
                            <SelectItem key={voice.voiceId} value={voice.voiceId}>
                              {voice.name}{voice.language ? ` · ${voice.language}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={voiceId}
                        onChange={(event) => setVoiceId(event.target.value)}
                        placeholder={voicesLoading ? "正在加载声线…" : "声线 ID，例如 eve"}
                        disabled={busy || voicesLoading}
                      />
                    )}
                  </LabeledControl>
                  <LabeledControl label="语言">
                    <Select value={language} onValueChange={setLanguage} disabled={busy}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {LANGUAGE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label} · {option.value}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </LabeledControl>
                  <LabeledControl label="语速">
                    <Input
                      type="number"
                      min={SPEED_MIN}
                      max={SPEED_MAX}
                      step="0.05"
                      value={speed}
                      onChange={(event) => setSpeed(event.target.value)}
                      disabled={busy}
                    />
                  </LabeledControl>
                  <LabeledControl label="音频格式">
                    <Select value={outputFormat} onValueChange={(value) => setOutputFormat(value as OutputFormat)} disabled={busy}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动</SelectItem>
                        {OUTPUT_FORMATS.map((format) => (
                          <SelectItem key={format} value={format}>{format.toUpperCase()}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </LabeledControl>
                  <label className="flex h-8 items-center gap-2 self-end rounded-md bg-secondary/55 px-3 text-xs">
                    <input
                      type="checkbox"
                      checked={withTimestamps}
                      onChange={(event) => setWithTimestamps(event.target.checked)}
                      disabled={busy}
                      className="size-3.5 accent-primary"
                    />
                    返回时间戳
                  </label>
                </div>

                {voicesError ? (
                  <div className="flex items-start gap-2 text-xs text-destructive">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap">声线列表加载失败：{voicesError}</span>
                    <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setVoiceReload((value) => value + 1)}>
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </div>
                ) : voicesLoading ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />正在加载声线</p>
                ) : null}

                <SubmitRow
                  busy={activeRequest === "tts"}
                  busyText="正在合成"
                  disabled={!text.trim() || !ttsModel || !voiceId.trim() || busy}
                  submitText="生成语音"
                  onCancel={cancelRequest}
                />
              </form>
            )
          ) : (
            sttModels.length === 0 ? (
              <MissingModelNotice kind="STT" onManage={onManage} />
            ) : (
              <form onSubmit={submitSTT} className="flex flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <LabeledControl label="模型">
                    <ModelSelect models={sttModels} value={sttModel} onChange={setSTTModel} disabled={busy} />
                  </LabeledControl>
                  <LabeledControl label="语言">
                    <Select value={sttLanguage} onValueChange={setSTTLanguage} disabled={busy}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动识别（不做数字规范化）</SelectItem>
                        {LANGUAGE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label} · {option.value}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </LabeledControl>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.ogg,.opus,.aac,.flac,.webm"
                  className="hidden"
                  onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
                />

                {audioFile ? (
                  <div className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs" title={audioFile.name}>{audioFile.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(audioFile.size)}</span>
                      <Button type="button" variant="ghost" size="icon" className="size-7" onClick={clearFile} disabled={busy} aria-label="移除音频">
                        <X className="size-3.5" />
                      </Button>
                    </div>
                    {filePreviewURL ? <audio controls preload="metadata" src={filePreviewURL} className="h-9 w-full" /> : null}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Upload className="size-5" />
                    选择音频文件
                  </button>
                )}

                <SubmitRow
                  busy={activeRequest === "stt"}
                  busyText="正在识别"
                  disabled={!audioFile || !sttModel || busy}
                  submitText="开始转写"
                  onCancel={cancelRequest}
                />
              </form>
            )
          )}

          {status ? <p aria-live="polite" className="text-xs text-muted-foreground">{status}</p> : null}
          {error ? <ErrorNotice message={error} /> : null}

          {mode === "tts" && ttsResult ? <AudioResult result={ttsResult} /> : null}
          {mode === "stt" && sttResult ? <TranscriptionResultView result={sttResult} /> : null}
        </div>
      </div>
    </div>
  );
}

function CapabilityGuide({ title, detail, onManage }: { title: string; detail: string; onManage?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-md">
        <AudioLines className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-medium">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
        {onManage ? <Button variant="outline" size="sm" className="mt-4" onClick={onManage}>打开设置</Button> : null}
      </div>
    </div>
  );
}

function MissingModelNotice({ kind, onManage }: { kind: "TTS" | "STT"; onManage?: () => void }) {
  return (
    <div className="py-20 text-center text-sm text-muted-foreground">
      <p>还没有保存 {kind} 模型</p>
      {onManage ? (
        <button type="button" onClick={onManage} className="mt-2 underline underline-offset-4 hover:text-foreground">
          去设置里挑选
        </button>
      ) : null}
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{children}</label>;
}

function LabeledControl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ModelSelect({
  models,
  value,
  onChange,
  disabled,
}: {
  models: CatalogModel[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled || models.length === 0}>
      <SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>{model.displayName ?? model.id}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SubmitRow({
  busy,
  busyText,
  disabled,
  submitText,
  onCancel,
}: {
  busy: boolean;
  busyText: string;
  disabled: boolean;
  submitText: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      {busy ? (
        <Button type="button" variant="outline" onClick={onCancel}>
          <Square className="size-3 fill-current" />取消
        </Button>
      ) : null}
      <Button type="submit" disabled={disabled}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : modeIcon(submitText)}
        {busy ? busyText : submitText}
      </Button>
    </div>
  );
}

function modeIcon(label: string) {
  return label === "生成语音" ? <AudioLines className="size-3.5" /> : <Mic className="size-3.5" />;
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p className="whitespace-pre-wrap">{message}</p>
    </div>
  );
}

function AudioResult({ result }: { result: SpeechAudioResult }) {
  const filename = `speech.${fileExtension(result.contentType)}`;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">合成结果</h2>
        <Button variant="outline" size="sm" asChild>
          <a href={result.url} download={filename}><Download className="size-3.5" />下载</a>
        </Button>
      </div>
      <audio controls preload="metadata" src={result.url} className="h-10 w-full" />
      <p className="text-[11px] text-muted-foreground">
        {result.contentType}{typeof result.duration === "number" ? ` · ${result.duration.toFixed(2)} 秒` : ""}
      </p>
    </section>
  );
}

function TranscriptionResultView({ result }: { result: TranscriptionResult }) {
  const meta = [
    result.language,
    typeof result.duration === "number" ? `${result.duration.toFixed(2)} 秒` : "",
    result.words?.length ? `${result.words.length} 个词` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-live="polite">
      <h2 className="text-sm font-medium">转写结果</h2>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{result.text}</p>
      {meta ? <p className="text-[11px] text-muted-foreground">{meta}</p> : null}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtension(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg") || contentType.includes("opus")) return "opus";
  if (contentType.includes("aac")) return "aac";
  if (contentType.includes("flac")) return "flac";
  return "mp3";
}
