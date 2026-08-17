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
import { validateSTTAudioFile } from "@/features/voice/audio-file";
import { AudioRecorderButton } from "@/features/voice/audio-recorder-button";
import type { AudioRecorderError, RecordedAudio, RecorderPhase } from "@/features/voice/browser-recorder";
import { GenerationHistory } from "@/features/history/generation-history";
import { hydrateAssets, toAsset, type GenerationRecord } from "@/features/history/generation-store";
import { useGenerationHistory } from "@/features/history/use-generation-history";
import { useAppSettings } from "@/shared/settings/app-settings";
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
  const settings = useAppSettings();
  /**
   * 能不能用只看设置页勾了什么，**不看后端方言**。
   *
   * 早先这里硬判 `backend.flavor === "grok2api"`，CPA 用户点进语音面板只能看到
   * 一句"当前后端不支持语音面板"。实测确实是 CPA 的 /tts /stt 全 404，但那是
   * 那一台部署的实况，不是 `cpa` 这个方言的定义 —— 换一台配了语音的 CPA
   * 就被冤枉了。判断权交回设置页的「显示哪些面板」。
   *
   * 一个都没勾时两个都放出来（`capabilities` 为空 = 用户没表过态）。
   */
  const knownCapabilities = backend.capabilities.length > 0;
  const hasTTS = !knownCapabilities || backend.capabilities.includes("tts");
  const hasSTT = !knownCapabilities || backend.capabilities.includes("stt");
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
  const [recorderPhase, setRecorderPhase] = useState<RecorderPhase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fileSelectionRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const audioResultRef = useRef<SpeechAudioResult | null>(null);

  const replaceAudioResult = useCallback((next: SpeechAudioResult | null) => {
    releaseSpeechAudio(audioResultRef.current);
    audioResultRef.current = next;
    setTTSResult(next);
  }, []);

  const history = useGenerationHistory(backend.id, "voice");
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);

  /**
   * 点回一条历史。TTS 那条要把存下来的字节重新造成对象 URL ——
   * 交给 `replaceAudioResult` 管生命周期，它本来就负责 revoke 上一条。
   */
  function showRecord(item: GenerationRecord) {
    // 请求运行中不允许历史记录替换当前模式和结果，否则取消按钮会被藏到另一个标签页。
    if (activeRequest !== null || recorderPhase !== "idle") return;
    const recordMode: VoiceMode = item.text !== undefined ? "stt" : "tts";
    if ((recordMode === "tts" && !hasTTS) || (recordMode === "stt" && !hasSTT)) {
      setStatus("");
      setError(recordMode === "tts"
        ? "这是一条文本转语音历史；请先在设置里开启语音合成再查看"
        : "这是一条语音转文字历史；请先在设置里开启语音转写再查看");
      return;
    }
    setError("");
    const params = item.params ?? {};

    if (item.text !== undefined) {
      setMode("stt");
      replaceAudioResult(null);
      clearFile();
      if (sttModels.some((model) => model.id === item.model)) setSTTModel(item.model);
      const storedLanguage = readStoredString(params.language);
      if (storedLanguage && (storedLanguage === "auto" || LANGUAGE_OPTIONS.some((option) => option.value === storedLanguage))) {
        setSTTLanguage(storedLanguage);
      } else {
        setSTTLanguage("auto");
      }
      setSTTResult({
        text: item.text,
        language: readStoredString(params.resultLanguage),
        duration: readStoredNumber(params.duration),
        words: readStoredWords(params.words),
      });
      setActiveRecordId(item.id);
      setStatus(`历史记录 · ${new Date(item.createdAt).toLocaleString()}`);
      return;
    }

    const { urls } = hydrateAssets(item);
    const first = urls[0];
    if (!first) {
      setError("这条历史记录里的音频已经不可用");
      return;
    }
    setMode("tts");
    setSTTResult(null);
    clearFile();
    if (ttsModels.some((model) => model.id === item.model)) setTTSModel(item.model);
    setText(readStoredString(params.prompt) ?? item.title);
    setVoiceId(readStoredString(params.voiceId) ?? "eve");
    const storedLanguage = readStoredString(params.language);
    if (storedLanguage && LANGUAGE_OPTIONS.some((option) => option.value === storedLanguage)) {
      setLanguage(storedLanguage);
    } else {
      setLanguage("zh");
    }
    const storedSpeed = readStoredNumber(params.speed);
    if (storedSpeed !== undefined && storedSpeed >= SPEED_MIN && storedSpeed <= SPEED_MAX) {
      setSpeed(String(storedSpeed));
    } else {
      setSpeed("1");
    }
    const storedFormat = readStoredString(params.outputFormat);
    if (isOutputFormat(storedFormat)) {
      setOutputFormat(storedFormat);
    } else {
      setOutputFormat("auto");
    }
    // source: "binary" 让 releaseSpeechAudio 认得这是需要 revoke 的对象 URL
    replaceAudioResult({
      url: first.url,
      contentType: first.contentType ?? "audio/mpeg",
      duration: readStoredNumber(params.duration),
      source: "binary",
    });
    setActiveRecordId(item.id);
    setStatus(`历史记录 · ${new Date(item.createdAt).toLocaleString()}`);
  }

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

  /**
   * 声线列表。
   *
   * 只在方言确定是 grok2api 时自动拉 —— 别的后端上 `/tts/voices` 大概率是 404，
   * 进个面板就自动打一发无谓的请求正是这个项目一直在避免的事。
   * 那种情况下改成手动点「加载声线」，不点就用输入框直接填声线 ID。
   */
  const autoLoadVoices = backend.flavor === "grok2api";

  useEffect(() => {
    if (mode !== "tts" || !hasTTS || !ttsModel || (!autoLoadVoices && voiceReload === 0)) {
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
  }, [autoLoadVoices, backend.apiKey, backend.baseURL, hasTTS, mode, ttsModel, voiceReload]);

  useEffect(() => () => {
    requestRef.current?.abort();
    releaseSpeechAudio(audioResultRef.current);
  }, []);

  if (!hasTTS && !hasSTT) {
    return (
      <CapabilityGuide
        title="语音面板被关掉了"
        detail="去设置页的「显示哪些面板」里勾上语音合成或语音转写。"
        onManage={onManage}
      />
    );
  }

  const busy = activeRequest !== null || recorderPhase !== "idle";

  function changeMode(value: string) {
    const next = value as VoiceMode;
    if (busy || (next === "tts" && !hasTTS) || (next === "stt" && !hasSTT)) return;
    requestRef.current?.abort();
    setMode(next);
    setError("");
    setStatus("");
  }

  function cancelRequest() {
    requestRef.current?.abort();
  }

  function handleRecordedAudio(recording: RecordedAudio) {
    setError("");
    void selectAudioFile(recording.file);
  }

  function handleRecorderError(recorderError: AudioRecorderError) {
    setStatus("");
    setError(recorderError.message);
  }

  async function submitTTS(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = text.trim();
    const selectedVoice = voiceId.trim();
    const selectedLanguage = language.trim();
    const parsedSpeed = Number(speed);
    if (!prompt || !ttsModel || !selectedVoice || !selectedLanguage || busy || requestRef.current) return;
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
        signal: controller.signal,
      });
      replaceAudioResult(result);
      setStatus("语音已生成");

      // blob: URL 一刷新就失效，所以历史里必须存字节，读回来再造新的对象 URL
      const asset = await toAsset(result.url);
      const saved = history.record({
        model: ttsModel,
        title: prompt,
        assets: [{ ...asset, contentType: asset.contentType ?? result.contentType }],
        params: {
          mode: "tts", prompt, voiceId: selectedVoice, language: selectedLanguage,
          speed: parsedSpeed, outputFormat, duration: result.duration,
        },
      });
      setActiveRecordId(saved.id);
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
    if (!audioFile || !sttModel || busy || requestRef.current) return;
    const fileSelection = fileSelectionRef.current;
    const validationError = await validateSTTAudioFile(audioFile);
    if (fileSelectionRef.current !== fileSelection) return;
    if (validationError) {
      setError(validationError);
      return;
    }
    // 文件头校验是异步的；挡住校验期间发生的第二次提交。
    if (requestRef.current) return;

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

      const saved = history.record({
        model: sttModel,
        // 转写没有提示词，用文件名当标题，正文存转写结果
        title: audioFile.name,
        assets: [],
        text: result.text,
        params: {
          mode: "stt",
          language: sttLanguage,
          resultLanguage: result.language,
          duration: result.duration,
          words: result.words,
        },
      });
      setActiveRecordId(saved.id);
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

  async function selectAudioFile(file: File) {
    const selection = fileSelectionRef.current + 1;
    fileSelectionRef.current = selection;
    setStatus("正在检查音频文件…");
    setError("");
    const validationError = await validateSTTAudioFile(file);
    if (fileSelectionRef.current !== selection) return;
    if (validationError) {
      setStatus("");
      setError(validationError);
      clearFile();
      return;
    }
    setStatus("");
    setAudioFile(file);
  }

  function clearFile() {
    fileSelectionRef.current += 1;
    setAudioFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function startNew() {
    if (busy) return;
    setTTSModel(ttsModels[0]?.id ?? "");
    setSTTModel(sttModels[0]?.id ?? "");
    setText("");
    setLanguage("zh");
    setSpeed("1");
    setOutputFormat("auto");
    setVoiceId(voices[0]?.voiceId ?? "eve");
    setSTTLanguage("auto");
    clearFile();
    replaceAudioResult(null);
    setSTTResult(null);
    setStatus("");
    setError("");
    setActiveRecordId(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col items-stretch gap-2 border-b px-3 py-2 md:flex-row md:items-center">
        <Tabs
          value={mode}
          onValueChange={changeMode}
          className="min-w-0 shrink-0"
        >
          <TabsList
            aria-label="语音功能模式"
            aria-describedby={!knownCapabilities ? "voice-capability-hint" : undefined}
            className="max-w-full overflow-x-auto"
          >
            <TabsTrigger value="tts" disabled={!hasTTS || busy} className="shrink-0 gap-1.5 whitespace-nowrap">
              <AudioLines className="size-3.5" />文本转语音
            </TabsTrigger>
            <TabsTrigger value="stt" disabled={!hasSTT || busy} className="shrink-0 gap-1.5 whitespace-nowrap">
              <Mic className="size-3.5" />语音转文字
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {!knownCapabilities ? (
          <span
            id="voice-capability-hint"
            role="note"
            title="设置中未指定面板能力，当前全部展示，是否可用以上游实际响应为准"
            className="min-w-0 max-w-full whitespace-normal text-left text-xs leading-4 text-muted-foreground md:ml-auto md:max-w-[50%] md:text-right"
          >
            设置中未指定面板能力，当前全部展示，是否可用以上游实际响应为准
          </span>
        ) : null}
      </div>

      <GenerationHistory
        records={history.records}
        activeId={activeRecordId}
        onNew={startNew}
        newLabel="新语音"
        newDisabled={busy}
        busy={busy}
        onOpen={showRecord}
        onDelete={(id) => {
          history.remove(id);
          if (id === activeRecordId) setActiveRecordId(null);
        }}
        onClear={() => { history.clear(); setActiveRecordId(null); }}
        emptyHint="合成过的语音和转写结果会存在这里。本地音频字节刷新后仍可播放；远程链接的有效期由上游决定。"
      />

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
                ) : !autoLoadVoices && voices.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="min-w-0 flex-1">声线列表不自动拉（这个后端未必有这个端点）。上面的输入框可以直接填 ID。</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setVoiceReload((value) => value + 1)}>
                      <RefreshCw className="size-3.5" />加载声线
                    </Button>
                  </div>
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
                  accept="audio/*,.mp3,.wav,.wave,.m4a,.ogg,.opus,.aac,.flac,.webm"
                  className="hidden"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    if (!file) return;
                    void selectAudioFile(file);
                  }}
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
                  <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 text-muted-foreground">
                    <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                      <AudioRecorderButton
                        mode={settings.recordingMode}
                        disabled={activeRequest !== null}
                        disabledReason="语音请求完成后才能录音"
                        onPhaseChange={setRecorderPhase}
                        onRecorded={handleRecordedAudio}
                        onError={handleRecorderError}
                        showStatus={recorderPhase !== "idle"}
                        className="border bg-background text-foreground"
                        containerClassName="max-w-full"
                      />
                      <span className="text-xs">或</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy}
                        className="gap-1.5"
                      >
                        <Upload className="size-4" />
                        选择音频文件
                      </Button>
                    </div>
                    <span className="text-[11px]">MP3、WAV、M4A、OGG、OPUS、AAC、FLAC、WebM · 最大 100 MB</span>
                  </div>
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

function readStoredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStoredNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function isOutputFormat(value: unknown): value is OutputFormat {
  return value === "auto" || OUTPUT_FORMATS.some((format) => format === value);
}

/** IndexedDB 里的旧记录或手改数据都不能直接断言成转写词数组。 */
function readStoredWords(value: unknown): TranscriptionResult["words"] {
  if (!Array.isArray(value)) return undefined;
  const words = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const text = readStoredString(row.text);
    const start = readStoredNumber(row.start);
    const end = readStoredNumber(row.end);
    if (!text || start === undefined || end === undefined) return [];
    const speaker = typeof row.speaker === "string" || typeof row.speaker === "number"
      ? row.speaker
      : undefined;
    return [{ text, start, end, speaker }];
  });
  return words.length > 0 ? words : undefined;
}
