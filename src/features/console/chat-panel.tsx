import { ArrowUp, BrainCircuit, Copy, Globe, ImagePlus, Keyboard, Loader2, Mic, Phone, RefreshCw, Square, Trash2, TriangleAlert, Volume2, VolumeX, Wrench, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Backend } from "@/backends/types";
import type { CatalogModel } from "@/backends/model-catalog";
import { streamChatCompletions, inferVendor, webSearchNote } from "@/transport/chat-completions";
import { isAbortError } from "@/transport/errors";
import { transcribeSpeech } from "@/transport/voice";
import { resolveVoiceConnection } from "@/transport/voice-routing";
import { readChatContentText, type ChatContentPart, type ChatMessageContent, type ChatStreamSnapshot, type ReasoningEffort } from "@/transport/types";
import { createMessageId, type ChatSession, type ConversationMessage } from "@/features/console/chat-store";
import { appendTranscriptionToDraft } from "@/features/console/chat-voice-input";
import { renderAssistantMarkup } from "@/features/console/markdown";
import { ModelPicker } from "@/features/console/model-picker";
import { prepareRecordedSTTAudioFile, validateSTTAudioFile } from "@/features/voice/audio-file";
import type { AudioRecorderError, RecordedAudio, RecorderPhase } from "@/features/voice/browser-recorder";
import { resolveVoiceCallConfig } from "@/features/voice/voice-call-config";
import { useChatReplySpeech, type ChatReplySpeechPhase } from "@/features/voice/use-chat-reply-speech";
import { useVoiceCall } from "@/features/voice/use-voice-call";
import { notifyTaskDone, shouldSubmitOnKey, useAppSettings } from "@/shared/settings/app-settings";
import { cn } from "@/shared/lib/cn";
import {
  IMAGE_INPUT_DATA_URL,
  isImageInputFile,
  readImageInputFile,
  type ImageInputFile,
} from "@/shared/image-input";

const AudioRecorderButton = lazy(() => import("@/features/voice/audio-recorder-button").then((module) => ({ default: module.AudioRecorderButton })));
const VoiceCallOverlay = lazy(() => import("@/features/voice/voice-call-overlay").then((module) => ({ default: module.VoiceCallOverlay })));
const VoiceCallMiniWindow = lazy(() => import("@/features/voice/voice-call-overlay").then((module) => ({ default: module.VoiceCallMiniWindow })));

const REASONING_LEVELS: ReasoningEffort[] = ["auto", "none", "low", "medium", "high", "xhigh"];

/** 单次聊天最多带 4 张图片，每张不超过 10 MiB。data URL 会随会话落进 IndexedDB，
 * 过大的原图既会拖慢请求，也容易把移动端内存顶满。 */
const MAX_CHAT_IMAGES = 4;
const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
type PendingImage = ImageInputFile;

type DisplayContent = {
  text: string;
  imageUrls: string[];
};

type SendOutcome = {
  status: "completed" | "aborted" | "failed" | "stale";
  text: string;
  error?: string;
};

function splitMessageContent(content: ChatMessageContent): DisplayContent {
  if (typeof content === "string") return { text: content, imageUrls: [] };

  const text: string[] = [];
  const imageUrls: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
    } else if (part.type === "image_url" && isSafeImageUrl(part.image_url.url)) {
      imageUrls.push(part.image_url.url);
    }
  }
  return { text: text.join(""), imageUrls };
}

function isSafeImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || IMAGE_INPUT_DATA_URL.test(value);
}

function buildUserContent(text: string, images: PendingImage[]): ChatMessageContent {
  if (images.length === 0) return text;

  const parts: ChatContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.dataUrl, detail: "auto" } });
  }
  return parts;
}

export function ChatPanel({
  backend,
  backends,
  models,
  session,
  onCommit,
  onManage,
  onVoiceCallActiveChange,
}: {
  backend: Backend;
  /** 包含语音设置可能引用的其它后端。 */
  backends: Backend[];
  /** 已经过滤成"用户保存过的"，可能为空 */
  models: CatalogModel[];
  session: ChatSession;
  onCommit: (session: ChatSession) => void;
  onManage: () => void;
  onVoiceCallActiveChange?: (active: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [readingImages, setReadingImages] = useState(0);
  const [draggingImages, setDraggingImages] = useState(false);
  const [streaming, setStreaming] = useState<ChatStreamSnapshot | null>(null);
  const [error, setError] = useState("");
  const [voiceInputMode, setVoiceInputMode] = useState(false);
  const [recorderPhase, setRecorderPhase] = useState<RecorderPhase>("idle");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [voiceCallExpanded, setVoiceCallExpanded] = useState(false);
  /**
   * 哪条消息露出了操作按钮。
   *
   * 移动端没有 hover，按钮要么一直挂在那儿（每条消息都挂三个图标，很吵），
   * 要么点一下才出来。选后者：点消息展开，点别处收起。
   * 桌面端 hover 也照样能出，两种输入方式各走各的。
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sttAbortRef = useRef<AbortController | null>(null);
  const streamSnapshotRef = useRef<ChatStreamSnapshot | null>(null);
  const requestSequenceRef = useRef(0);
  const sttSequenceRef = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceCallButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragDepthRef = useRef(0);
  const readingImageStatsRef = useRef({ count: 0, bytes: 0 });
  const currentSessionIdRef = useRef(session.id);
  currentSessionIdRef.current = session.id;
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;
  const settings = useAppSettings();

  const commitSession = useCallback((next: ChatSession) => {
    latestSessionRef.current = next;
    onCommit(next);
  }, [onCommit]);

  // 草稿属于当前会话。切换历史时丢掉尚未发送的图片，避免误发到另一段对话。
  useEffect(() => {
    setInput("");
    setPendingImages([]);
    setReadingImages(0);
    setDraggingImages(false);
    setStreaming(null);
    setError("");
    setVoiceInputMode(false);
    setRecorderPhase("idle");
    setTranscribing(false);
    setVoiceStatus("");
    setVoiceError("");
    dragDepthRef.current = 0;
    readingImageStatsRef.current = { count: 0, bytes: 0 };
    streamSnapshotRef.current = null;

    return () => {
      // 切会话、删当前会话或切后端时，旧请求不能再把旧会话写回当前界面。
      requestSequenceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      sttSequenceRef.current += 1;
      sttAbortRef.current?.abort();
      sttAbortRef.current = null;
    };
  }, [backend.id, session.id]);

  const model = models.some((item) => item.id === session.model) ? session.model : models[0]?.id ?? "";
  const activeModel = models.find((item) => item.id === model);
  const sttConnection = resolveVoiceConnection(backend, backends, "stt");
  const ttsConnection = resolveVoiceConnection(backend, backends, "tts");
  const chatInputSTTModel = sttConnection.model;
  const chatSTTReady = sttConnection.ready;
  const voiceBusy = recorderPhase !== "idle" || transcribing;
  const searchMode = backend.webSearchModeOverrides[model] ?? "auto";
  const search = webSearchNote(model, searchMode);
  const voiceCallConfig = resolveVoiceCallConfig({
    chatModel: model,
    sttConnection,
    ttsConnection,
  });
  const chatReplySpeech = useChatReplySpeech({
    connection: ttsConnection,
    contextKey: `${backend.id}:${session.id}`,
    onError: (message) => toast.error(`回复朗读失败：${message}`),
  });
  const voiceCall = useVoiceCall({
    config: voiceCallConfig,
    contextKey: `${backend.id}:${session.id}`,
    onAssistantTurn: sendVoiceCallTurn,
    onAbortAssistant: () => abortRef.current?.abort(),
  });

  useEffect(() => {
    onVoiceCallActiveChange?.(voiceCall.state.open);
    if (!voiceCall.state.open) setVoiceCallExpanded(false);
  }, [onVoiceCallActiveChange, voiceCall.state.open]);

  useEffect(() => () => onVoiceCallActiveChange?.(false), [onVoiceCallActiveChange]);

  const addImageFiles = useCallback((incoming: FileList | File[]) => {
    const files = Array.from(incoming);
    if (files.length === 0) return;
    const targetSessionId = session.id;

    const imageFiles = files.filter(isImageInputFile);
    if (imageFiles.length < files.length) {
      toast.error("只支持图片文件，其他文件已忽略");
    }

    const reading = readingImageStatsRef.current;
    const available = MAX_CHAT_IMAGES - pendingImages.length - reading.count;
    if (available <= 0) {
      toast.error("一条消息最多带 " + MAX_CHAT_IMAGES + " 张图片");
      return;
    }

    const selected = imageFiles.slice(0, available);
    if (imageFiles.length > available) {
      toast.error("一条消息最多带 " + MAX_CHAT_IMAGES + " 张图片，多余的已忽略");
    }

    const withinPerImageLimit = selected.filter((file) => file.size <= MAX_CHAT_IMAGE_BYTES);
    if (withinPerImageLimit.length < selected.length) {
      toast.error("单张图片不能超过 10 MB，超出的已忽略");
    }

    const pendingBytes = pendingImages.reduce((total, image) => total + image.size, 0);
    let selectedBytes = 0;
    let totalLimitReached = false;
    const valid = withinPerImageLimit.filter((file) => {
      if (pendingBytes + reading.bytes + selectedBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
        totalLimitReached = true;
        return false;
      }
      selectedBytes += file.size;
      return true;
    });
    if (totalLimitReached) {
      toast.error("一条消息里的图片合计不能超过 20 MB，超出的已忽略");
    }
    if (valid.length === 0) return;

    readingImageStatsRef.current = {
      count: reading.count + valid.length,
      bytes: reading.bytes + selectedBytes,
    };
    setReadingImages((count) => count + valid.length);
    void Promise.allSettled(valid.map((file) => readImageInputFile(file, createMessageId()))).then((results) => {
      if (currentSessionIdRef.current !== targetSessionId) return;
      const loaded = results
        .filter((result): result is PromiseFulfilledResult<PendingImage> => result.status === "fulfilled")
        .map((result) => result.value);
      if (loaded.length > 0) {
        setPendingImages((current) => [...current, ...loaded].slice(0, MAX_CHAT_IMAGES));
      }
      if (loaded.length < valid.length) {
        toast.error("有图片读取失败，请重试");
      }
    }).finally(() => {
      if (currentSessionIdRef.current !== targetSessionId) return;
      const current = readingImageStatsRef.current;
      readingImageStatsRef.current = {
        count: Math.max(0, current.count - valid.length),
        bytes: Math.max(0, current.bytes - selectedBytes),
      };
      setReadingImages((count) => Math.max(0, count - valid.length));
    });
  }, [pendingImages.length, session.id]);

  function removePendingImage(id: string) {
    setPendingImages((current) => current.filter((image) => image.id !== id));
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    addImageFiles(files);
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (voiceCall.state.open) return;
    dragDepthRef.current += 1;
    setDraggingImages(true);
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (voiceCall.state.open) return;
    if (!draggingImages) setDraggingImages(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (voiceCall.state.open) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggingImages(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (voiceCall.state.open) return;
    dragDepthRef.current = 0;
    setDraggingImages(false);
    if (event.dataTransfer.files.length > 0) addImageFiles(event.dataTransfer.files);
  }

  function handleRecorderPhaseChange(phase: RecorderPhase) {
    setRecorderPhase(phase);
    if (phase !== "idle") {
      chatReplySpeech.stop();
      setVoiceStatus("");
      setVoiceError("");
    }
  }

  function handleRecorderError(recorderError: AudioRecorderError) {
    setVoiceStatus("");
    setVoiceError(recorderError.message);
    setVoiceInputMode(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function enterVoiceInputMode() {
    setVoiceStatus("");
    setVoiceError("");
    textareaRef.current?.blur();
    setVoiceInputMode(true);
  }

  function leaveVoiceInputMode() {
    if (recorderPhase !== "idle") return;
    if (transcribing) cancelTranscription();
    setVoiceInputMode(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function cancelTranscription() {
    sttSequenceRef.current += 1;
    sttAbortRef.current?.abort();
    sttAbortRef.current = null;
    setTranscribing(false);
    setVoiceStatus("");
    setVoiceError("");
  }

  async function transcribeRecording(recording: RecordedAudio) {
    const targetSessionId = session.id;
    const selectedModel = chatInputSTTModel;
    const sequence = sttSequenceRef.current + 1;
    sttSequenceRef.current = sequence;
    let controller: AbortController | null = null;
    const isCurrent = () => (
      sttSequenceRef.current === sequence && currentSessionIdRef.current === targetSessionId
    );

    setTranscribing(true);
    setVoiceStatus("正在检查录音…");
    setVoiceError("");

    try {
      if (!sttConnection.ready) {
        throw new Error(sttConnection.reason || "语音转写配置不可用，请在设置的“语音”页重新选择");
      }
      if (!selectedModel) throw new Error("请先在设置的“语音”页选择语音转写模型");
      controller = new AbortController();
      sttAbortRef.current = controller;
      const audioFile = await prepareRecordedSTTAudioFile(recording.file, recording.durationMs, {
        signal: controller.signal,
      });
      const validationError = await validateSTTAudioFile(audioFile);
      if (!isCurrent()) return;
      if (validationError) throw new Error(validationError);

      setVoiceStatus("正在将录音转成文字…");
      const result = await transcribeSpeech({
        baseURL: sttConnection.baseURL,
        apiKey: sttConnection.apiKey,
        protocol: sttConnection.protocol,
        model: selectedModel,
        file: audioFile,
        signal: controller.signal,
      });
      if (!isCurrent() || sttAbortRef.current !== controller) return;

      const transcription = result.text.trim();
      if (!transcription) throw new Error("语音识别没有返回文字");
      if (sttAbortRef.current === controller) sttAbortRef.current = null;
      setTranscribing(false);
      if (
        inputRef.current.trim()
        || pendingImagesRef.current.length > 0
        || readingImageStatsRef.current.count > 0
      ) {
        setInput((current) => appendTranscriptionToDraft(current, transcription));
        setVoiceInputMode(false);
        setVoiceStatus("已有草稿或图片，语音已填入输入框，请确认后发送");
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      setVoiceStatus("");
      void sendTranscribedTurn(transcription, targetSessionId);
    } catch (caught) {
      if (!isCurrent()) return;
      setVoiceStatus("");
      if (!isAbortError(caught)) {
        setVoiceError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (sttSequenceRef.current === sequence) {
        if (controller && sttAbortRef.current === controller) sttAbortRef.current = null;
        setTranscribing(false);
      }
    }
  }

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  async function send(
    messages: ConversationMessage[],
    base: ChatSession,
    options: { notify?: boolean } = {},
  ): Promise<SendOutcome> {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    const controller = new AbortController();
    abortRef.current = controller;
    const initialSnapshot: ChatStreamSnapshot = { text: "", reasoning: "", tools: [] };
    streamSnapshotRef.current = initialSnapshot;
    setError("");
    setStreaming(initialSnapshot);
    const isCurrentRequest = () => (
      requestSequenceRef.current === sequence && currentSessionIdRef.current === base.id
    );

    try {
      const result = await streamChatCompletions({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        model: base.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        reasoningEffort: base.reasoningEffort,
        webSearch: base.webSearch,
        webSearchMode: backend.webSearchModeOverrides[base.model] ?? "auto",
        searchProvider: settings.searchProvider,
        searchApiKey: settings.searchApiKey,
        searchBaseUrl: settings.searchBaseUrl,
        flavor: backend.flavor,
        vendor: inferVendor(base.model),
        onUpdate: (snapshot) => {
          if (!isCurrentRequest()) return;
          streamSnapshotRef.current = snapshot;
          setStreaming(snapshot);
        },
        signal: controller.signal,
      });

      if (!isCurrentRequest()) return { status: "stale", text: "" };
      const committed: ChatSession = {
        ...base,
        messages: [...messages, {
          id: createMessageId(),
          role: "assistant",
          content: result.text,
          reasoning: result.reasoning || undefined,
          tools: result.tools.length > 0 ? result.tools : undefined,
          nativeFinishReason: result.nativeFinishReason,
        }],
        updatedAt: Date.now(),
      };
      commitSession(committed);
      if (options.notify !== false) notifyTaskDone("回复完成", result.text.slice(0, 120) || base.model);
      return { status: "completed", text: result.text };
    } catch (caught) {
      if (!isCurrentRequest()) return { status: "stale", text: "" };
      // 用户主动停止不算错误，但已经流出来的内容要保留下来
      if (isAbortError(caught)) {
        const snapshot = streamSnapshotRef.current;
        if (snapshot && (snapshot.text || snapshot.reasoning)) {
          commitSession({
            ...base,
            messages: [...messages, {
              id: createMessageId(),
              role: "assistant",
              content: snapshot.text,
              reasoning: snapshot.reasoning || undefined,
              tools: snapshot.tools.length > 0 ? snapshot.tools : undefined,
              nativeFinishReason: snapshot.nativeFinishReason,
            }],
            updatedAt: Date.now(),
          });
        } else {
          // `submit` 已经先落过用户消息；重新生成被停止时则在这里保留截断后的上下文。
          commitSession({ ...base, messages, updatedAt: Date.now() });
        }
        return { status: "aborted", text: snapshot?.text ?? "" };
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      // 用户消息也要留住，否则报错后输入的内容就白打了
      commitSession({ ...base, messages, updatedAt: Date.now() });
      return { status: "failed", text: "", error: message };
    } finally {
      if (requestSequenceRef.current === sequence) {
        abortRef.current = null;
        streamSnapshotRef.current = null;
        setStreaming(null);
      }
    }
  }

  async function sendVoiceCallTurn(text: string): Promise<SendOutcome> {
    const current = latestSessionRef.current;
    const userMessage: ConversationMessage = {
      id: createMessageId(),
      role: "user",
      content: text,
    };
    const messages = [...current.messages, userMessage];
    const base: ChatSession = {
      ...current,
      model: voiceCallConfig.chatModel,
      messages,
      updatedAt: Date.now(),
    };
    // 先同步更新 ref：回复播完立即进入下一轮时，不必等父组件重渲染才能拿到新上下文。
    commitSession(base);
    return send(messages, base, { notify: false });
  }

  async function sendTranscribedTurn(text: string, targetSessionId: string) {
    if (currentSessionIdRef.current !== targetSessionId || voiceCall.state.open) return;
    if (abortRef.current) {
      setVoiceError("当前回复结束后才能发送语音");
      return;
    }

    const transcription = text.trim();
    if (!transcription) return;
    const current = latestSessionRef.current;
    const effectiveModel = models.some((item) => item.id === current.model)
      ? current.model
      : models[0]?.id ?? "";
    if (!effectiveModel) {
      setVoiceError("请先选择聊天模型");
      return;
    }

    const userMessage: ConversationMessage = {
      id: createMessageId(),
      role: "user",
      content: transcription,
    };
    const messages = [...current.messages, userMessage];
    const base: ChatSession = {
      ...current,
      model: effectiveModel,
      messages,
      updatedAt: Date.now(),
    };
    commitSession(base);
    const outcome = await send(messages, base);
    speakCompletedChatReply(outcome);
  }

  function speakCompletedChatReply(outcome: SendOutcome) {
    if (outcome.status === "completed" && outcome.text.trim()) {
      void chatReplySpeech.speak(outcome.text);
    }
  }

  function toggleChatReplySpeech() {
    const result = chatReplySpeech.toggle();
    if (result.ok) return;
    toast.error(result.reason);
    onManage();
  }

  function startVoiceCall() {
    if (voiceCall.state.open) {
      setVoiceCallExpanded(true);
      return;
    }
    if (streaming || abortRef.current || voiceBusy) {
      toast.error("请等当前录音或回复结束后再开始通话");
      return;
    }
    chatReplySpeech.stop();
    const result = voiceCall.start();
    if (result.ok) {
      setVoiceCallExpanded(true);
      return;
    }
    toast.error(result.reason || "语音通话配置不可用");
    onManage();
  }

  function endVoiceCall() {
    setVoiceCallExpanded(false);
    voiceCall.end();
    requestAnimationFrame(() => voiceCallButtonRef.current?.focus());
  }

  function minimizeVoiceCall() {
    setVoiceCallExpanded(false);
  }

  function expandVoiceCall() {
    setVoiceCallExpanded(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (voiceCall.state.open || (!text && pendingImages.length === 0) || readingImages > 0 || streaming || abortRef.current || voiceBusy || !model) return;
    const userMessage: ConversationMessage = {
      id: createMessageId(),
      role: "user",
      content: buildUserContent(text, pendingImages),
    };
    const messages = [...session.messages, userMessage];
    const base = { ...session, model, messages, updatedAt: Date.now() };
    if (settings.clearInputAfterSubmit) setInput("");
    setPendingImages([]);
    chatReplySpeech.stop();
    // 先落盘再请求：发送后的图片立即可见，首个响应片段前停止也不会丢消息。
    commitSession(base);
    void send(messages, base).then(speakCompletedChatReply);
  }

  /**
   * 删掉一条消息。只删这一条，不连带删它的问/答 ——
   * 想删整轮就点两下，比"我以为只删一条结果少了两条"强。
   *
   * 注意删完可能出现两条同角色相邻（删掉中间那条 user 之后 assistant 挨着
   * assistant），有些上游要求严格交替会因此报 400。这是用户自己剪的，
   * 报错也指得回来，所以不在这里替他挡。
   */
  function deleteMessage(id: string) {
    setSelectedId(null);
    onCommit({
      ...session,
      messages: session.messages.filter((message) => message.id !== id),
      updatedAt: Date.now(),
    });
  }

  async function copyMessage(content: ChatMessageContent) {
    const text = readChatContentText(content);
    if (!text) {
      toast.error("这条消息没有可复制的文字");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制");
    } catch {
      // http 页面或者用户拒了剪贴板权限。别静默失败，不然像是按钮坏了。
      toast.error("复制失败，浏览器不给剪贴板权限");
    }
  }

  /**
   * 从这条消息重新生成。
   *
   * 点在回复上 = 丢掉这条回复，拿它前面的上下文重问一次；
   * 点在提问上 = 从这一问重来，它后面的全部丢掉。
   * 两种都是"回到这里再跑一遍"，所以共用一个按钮。
   *
   * 丢掉的部分不进历史 —— 想留旧回复就先复制走。
   */
  function regenerateFrom(id: string) {
    if (voiceCall.state.open || streaming || abortRef.current || voiceBusy) return;
    setSelectedId(null);
    const index = session.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    const target = session.messages[index];
    const kept = session.messages.slice(0, target.role === "user" ? index + 1 : index);
    if (kept.length === 0) return;
    const base = { ...session, model };
    chatReplySpeech.stop();
    void send(kept, base).then(speakCompletedChatReply);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 具体哪个键发送看设置页；输入法组合中的回车一律不拦（中文输入按回车是选词）。
    if (shouldSubmitOnKey(event, settings.submitMode)) {
      event.preventDefault();
      submit(event as unknown as FormEvent);
    }
  }

  const rendered = useMemo(
    () => session.messages.map((message) => ({
      message,
      html: message.role === "assistant" ? renderAssistantMarkup(readChatContentText(message.content)) : "",
    })),
    [session.messages],
  );

  return (
    /* 点消息以外的任何地方都收起操作按钮 —— 不用另外找"取消"的地方 */
    <div className="flex h-full flex-col" onClick={() => setSelectedId(null)}>
      <div className="contents" inert={(voiceCall.state.open && voiceCallExpanded) || undefined}>
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <div className="contents" inert={voiceCall.state.open || undefined}>
          <ModelPicker
            models={models}
            value={model}
            onChange={(id) => onCommit({ ...session, model: id })}
            onManage={onManage}
          />

          {/*
            推理档位和联网搜索都不再按模型能力上锁 —— 判定是拿模型 id 猜的
            （`isReasoningModel` / `inferVendor` 都只是子串匹配），猜错就把能用的
            功能锁死了，而且用户根本看不出是"锁了"还是"没这功能"。
            两个控件的默认值都是不发（`auto` / 关），真发出去一定是用户点过的。
            上游不认就让它报错，报错至少指得回来。
          */}
          <Select
            value={session.reasoningEffort}
            onValueChange={(value) => onCommit({ ...session, reasoningEffort: value as ReasoningEffort })}
          >
            <SelectTrigger
              className={cn(
                "h-8 w-auto gap-1 rounded-full border-0 bg-transparent px-2.5 text-xs shadow-none",
                !activeModel?.reasoning && "text-muted-foreground",
              )}
            >
              <BrainCircuit className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_LEVELS.map((level) => (
                <SelectItem key={level} value={level} className="text-xs">{level}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <WebSearchToggle
            enabled={session.webSearch}
            note={search}
            onToggle={() => onCommit({ ...session, webSearch: !session.webSearch })}
          />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={voiceCallButtonRef}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={voiceCall.state.open ? "返回语音通话" : "开始语音通话"}
              className="ml-auto size-8 shrink-0 rounded-full text-muted-foreground"
              onClick={startVoiceCall}
            >
              <Phone className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{voiceCall.state.open ? "返回语音通话" : "开始语音通话"}</TooltipContent>
        </Tooltip>
      </div>

      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-3">
            <MessageScrollerContent className="mx-auto flex max-w-3xl flex-col gap-4 py-4">
              {rendered.length === 0 && !streaming ? (
                <EmptyState hasModels={models.length > 0} onManage={onManage} />
              ) : null}

              {rendered.map(({ message, html }) => (
                <MessageScrollerItem key={message.id}>
                  <ChatBubble
                    message={message}
                    html={html}
                    selected={selectedId === message.id}
                    onSelect={() => setSelectedId((current) => current === message.id ? null : message.id)}
                    onCopy={() => { void copyMessage(message.content); }}
                    /*
                      流式过程中不给删也不给重生成 —— `send()` 里捏着一份发请求
                      那一刻的 messages，结束时会用它拼上回复整个覆盖回去，
                      这中间改过的都会被原样冲掉。
                    */
                    onRegenerate={streaming || voiceCall.state.open ? undefined : () => regenerateFrom(message.id)}
                    onDelete={streaming || voiceCall.state.open ? undefined : () => deleteMessage(message.id)}
                  />
                </MessageScrollerItem>
              ))}

              {streaming ? (
                <MessageScrollerItem>
                  <StreamingBubble snapshot={streaming} />
                </MessageScrollerItem>
              ) : null}

              {error ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <p className="whitespace-pre-wrap">{error}</p>
                </div>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form
        onSubmit={submit}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn("shrink-0 px-3 safe-area-bottom-3", voiceCall.state.open && "opacity-60")}
        inert={voiceCall.state.open || undefined}
        aria-disabled={voiceCall.state.open || undefined}
      >
        <div
          className={cn(
            "relative mx-auto max-w-3xl overflow-hidden rounded-2xl border bg-card p-2 transition-colors focus-within:border-border-hover",
            draggingImages && "border-primary bg-primary/5",
          )}
        >
          {draggingImages ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-card/90 text-xs text-primary">
              <ImagePlus className="size-4" />
              松开以上传图片
            </div>
          ) : null}

          {pendingImages.length > 0 ? (
            <div className="mb-1.5 flex flex-wrap gap-2 px-1 pt-1">
              {pendingImages.map((image) => (
                <PendingImagePreview key={image.id} image={image} onRemove={() => removePendingImage(image.id)} />
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-1.5">
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
            {voiceInputMode ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="切换到文字输入"
                      disabled={voiceCall.state.open || recorderPhase !== "idle"}
                      className="size-9 shrink-0 rounded-full text-muted-foreground"
                      onClick={leaveVoiceInputMode}
                    >
                      <Keyboard className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>切换到文字输入</TooltipContent>
                </Tooltip>

                {transcribing ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 min-w-0 flex-1 gap-2 rounded-xl"
                    onClick={cancelTranscription}
                  >
                    <Square className="size-3.5 fill-current" />
                    正在识别，点击取消
                  </Button>
                ) : (
                  <Suspense fallback={<Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />}>
                    <AudioRecorderButton
                      key={`${backend.id}:${session.id}:${sttConnection.targetBackendId}:${sttConnection.baseURL}:${sttConnection.protocol}:${chatInputSTTModel}`}
                      wide
                      disabled={voiceCall.state.open || models.length === 0 || streaming !== null}
                      disabledReason={streaming ? "回复完成后才能录音" : undefined}
                      onPhaseChange={handleRecorderPhaseChange}
                      onRecorded={(recording) => { void transcribeRecording(recording); }}
                      onError={handleRecorderError}
                      className="border bg-secondary/55 text-foreground"
                      containerClassName="min-w-0 flex-1"
                    />
                  </Suspense>
                )}
                <ReplySpeechToggle
                  enabled={chatReplySpeech.enabled}
                  phase={chatReplySpeech.phase}
                  disabled={voiceCall.state.open}
                  onToggle={toggleChatReplySpeech}
                />
              </>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="添加图片"
                      disabled={voiceCall.state.open || models.length === 0 || streaming !== null || voiceBusy}
                      className="size-9 shrink-0 rounded-full text-muted-foreground"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>添加图片</TooltipContent>
                </Tooltip>

                {settings.showChatMicrophone ? (
                  chatSTTReady ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="切换到语音输入"
                          disabled={voiceCall.state.open || models.length === 0 || streaming !== null || voiceBusy}
                          className="size-9 shrink-0 rounded-full text-muted-foreground"
                          onClick={enterVoiceInputMode}
                        >
                          <Mic className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>切换到语音输入</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="设置语音转写供应商"
                          disabled={voiceCall.state.open || streaming !== null}
                          className="size-9 shrink-0 rounded-full text-muted-foreground"
                          onClick={onManage}
                        >
                          <Mic className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{sttConnection.reason || "请在设置的“语音”页选择语音转写供应商和模型"}</TooltipContent>
                    </Tooltip>
                  )
                ) : null}

                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={handlePaste}
                  placeholder={voiceCall.state.open
                    ? "语音通话中…"
                    : models.length === 0
                      ? "先去设置里保存几个模型"
                      : "说点什么…"}
                  rows={1}
                  disabled={models.length === 0 || voiceCall.state.open}
                  className="max-h-40 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <ReplySpeechToggle
                  enabled={chatReplySpeech.enabled}
                  phase={chatReplySpeech.phase}
                  disabled={voiceCall.state.open}
                  onToggle={toggleChatReplySpeech}
                />
                {streaming ? (
                  <Button type="button" size="icon" aria-label="停止生成" className="size-9 shrink-0 rounded-full" onClick={stop}>
                    <Square className="size-3.5 fill-current" />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    size="icon"
                    className="size-9 shrink-0 rounded-full"
                    disabled={voiceCall.state.open || (!input.trim() && pendingImages.length === 0) || readingImages > 0 || voiceBusy || !model}
                    aria-label={readingImages > 0 ? "正在读取图片" : "发送"}
                  >
                    {readingImages > 0 ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
                  </Button>
                )}
              </>
            )}
          </div>

          {voiceStatus || voiceError ? (
            <div
              role={voiceError ? "alert" : "status"}
              aria-live={voiceError ? "assertive" : "polite"}
              className={cn(
                "mt-1 flex items-center gap-1.5 px-2 text-xs",
                voiceError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {voiceError
                ? <TriangleAlert className="size-3.5 shrink-0" />
                : <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              <span className="min-w-0 break-words">{voiceError || voiceStatus}</span>
            </div>
          ) : null}
        </div>
      </form>
      </div>

      <Suspense fallback={null}>
        <VoiceCallOverlay
          open={voiceCall.state.open && voiceCallExpanded}
          phase={voiceCall.state.phase}
          modelName={activeModel?.displayName || model}
          elapsedMs={voiceCall.state.elapsedMs}
          muted={voiceCall.state.muted}
          soundEnabled={voiceCall.state.soundEnabled}
          latestUserText={voiceCall.state.latestUserText}
          latestAssistantText={voiceCall.state.latestAssistantText}
          error={voiceCall.state.error}
          onMinimize={minimizeVoiceCall}
          onToggleMute={voiceCall.toggleMute}
          onToggleSound={voiceCall.toggleSound}
          onInterrupt={voiceCall.interrupt}
          onFinishSpeaking={voiceCall.finishSpeaking}
          onRetry={voiceCall.retry}
          onEnd={endVoiceCall}
        />

        <VoiceCallMiniWindow
          open={voiceCall.state.open && !voiceCallExpanded}
          phase={voiceCall.state.phase}
          modelName={activeModel?.displayName || model}
          elapsedMs={voiceCall.state.elapsedMs}
          muted={voiceCall.state.muted}
          error={voiceCall.state.error}
          onExpand={expandVoiceCall}
          onEnd={endVoiceCall}
        />
      </Suspense>
    </div>
  );
}

function ReplySpeechToggle({
  enabled,
  phase,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  phase: ChatReplySpeechPhase;
  disabled: boolean;
  onToggle: () => void;
}) {
  const label = enabled ? "自动朗读回复：已开启" : "自动朗读回复：已关闭";
  const Icon = enabled ? Volume2 : VolumeX;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={enabled ? "secondary" : "ghost"}
          size="icon"
          className="size-9 shrink-0 rounded-full text-muted-foreground"
          aria-label={label}
          aria-pressed={enabled}
          disabled={disabled}
          onClick={onToggle}
        >
          <Icon className={cn("size-4", enabled && phase !== "idle" && "animate-pulse")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 联网搜索开关。
 *
 * 带文字标签而不是一个光秃秃的地球图标 —— 纯图标在这排控件里太不显眼，
 * 用户反馈"有点不明显"。开启态用主色反相（和发送按钮同一套语言），
 * 单色系里这是最强的"开着"信号。
 *
 * **任何模型上都能点。** 之前按 `inferVendor` 的结果禁用，但那只是拿模型 id
 * 猜厂商，猜错就把能用的功能锁死；`note` 现在只写进 tooltip 当提示，不做拦截。
 */
function WebSearchToggle({
  enabled,
  note,
  onToggle,
}: {
  enabled: boolean;
  note: { known: boolean; note: string };
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={enabled}
          className={cn(
            "gap-1.5 border px-2.5",
            enabled
              ? "border-transparent bg-primary text-primary-foreground hover:bg-primary/84"
              : "border-border text-muted-foreground",
          )}
          onClick={onToggle}
        >
          <Globe className="size-3.5" />
          联网
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {enabled ? "已开启联网搜索 · " : "点一下开启联网搜索 · "}
        {note.note}
      </TooltipContent>
    </Tooltip>
  );
}

function EmptyState({ hasModels, onManage }: { hasModels: boolean; onManage: () => void }) {
  if (!hasModels) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        <p>还没有保存任何模型</p>
        <button type="button" onClick={onManage} className="mt-2 underline underline-offset-4 hover:text-foreground">
          去设置里挑几个
        </button>
      </div>
    );
  }
  return <p className="py-20 text-center text-sm text-muted-foreground">发消息开始对话</p>;
}

type BubbleActions = {
  selected: boolean;
  onSelect: () => void;
  onCopy: () => void;
  onRegenerate?: () => void;
  onDelete?: () => void;
};

function PendingImagePreview({ image, onRemove }: { image: PendingImage; onRemove: () => void }) {
  return (
    <div
      className="group/image relative size-16 shrink-0 overflow-hidden rounded-md border bg-secondary"
      title={image.name}
    >
      <img src={image.dataUrl} alt={image.name} className="size-full object-cover" />
      <button
        type="button"
        aria-label={"移除 " + image.name}
        className="absolute right-0.5 top-0.5 flex size-7 items-center justify-center rounded bg-black/70 text-white opacity-90 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        onClick={(event) => { event.stopPropagation(); onRemove(); }}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function ChatBubble({
  message,
  html,
  ...actions
}: { message: ConversationMessage; html: string } & BubbleActions) {
  const content = splitMessageContent(message.content);
  const body = message.role === "user" ? (
    <MessageContent className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-sm">
      {content.imageUrls.length > 0 ? <MessageImages urls={content.imageUrls} /> : null}
      {content.text ? <p>{content.text}</p> : null}
    </MessageContent>
  ) : (
    <MessageContent className="w-full text-sm">
      {message.reasoning ? <ReasoningBlock text={message.reasoning} /> : null}
      {message.tools?.map((tool) => <ToolChip key={tool.id} name={tool.name} status={tool.status} />)}
      {content.imageUrls.length > 0 ? <MessageImages urls={content.imageUrls} /> : null}
      {content.text ? <AssistantBody content={content.text} html={html} /> : null}
    </MessageContent>
  );

  return (
    <div
      /* 阻止冒泡，否则这一下会立刻被外层的"点别处收起"抵消掉 */
      onClick={(event) => { event.stopPropagation(); actions.onSelect(); }}
      className="group/bubble flex flex-col gap-1"
    >
      <Message align={message.role === "user" ? "end" : "start"}>{body}</Message>
      <MessageActions {...actions} align={message.role === "user" ? "end" : "start"} />
    </div>
  );
}

function MessageImages({ urls }: { urls: string[] }) {
  return (
    <div className={cn("grid w-64 max-w-full gap-1.5", urls.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
      {urls.map((url, index) => (
        <a
          key={"image-" + index}
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={"查看第 " + (index + 1) + " 张图片"}
          className={cn(
            "block overflow-hidden rounded-md border bg-card",
            urls.length > 1 ? "aspect-square" : "max-h-80",
          )}
        >
          <img
            src={url}
            alt={"对话图片 " + (index + 1)}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("w-full object-contain", urls.length > 1 ? "size-full" : "max-h-80")}
          />
        </a>
      ))}
    </div>
  );
}

/**
 * 复制 / 重新生成 / 删除。
 *
 * 常驻占位但默认透明 —— 显隐时不改变高度，列表不会在手底下跳。
 * 桌面端 hover 出现，移动端点一下消息出现（`selected`），点别处收起。
 */
function MessageActions({
  selected,
  align,
  onCopy,
  onRegenerate,
  onDelete,
}: BubbleActions & { align: "start" | "end" }) {
  return (
    <div
      className={cn(
        "flex h-6 items-center gap-0.5 opacity-0 transition-opacity",
        "pointer-events-none group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100",
        "focus-within:pointer-events-auto focus-within:opacity-100",
        align === "end" && "justify-end",
        selected && "pointer-events-auto opacity-100",
      )}
    >
      <ActionButton label="复制" onClick={onCopy}><Copy className="size-3.5" /></ActionButton>
      {onRegenerate ? (
        <ActionButton label="重新生成" onClick={onRegenerate}><RefreshCw className="size-3.5" /></ActionButton>
      ) : null}
      {onDelete ? (
        <ActionButton label="删除这条消息" onClick={onDelete}><Trash2 className="size-3.5" /></ActionButton>
      ) : null}
    </div>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function StreamingBubble({ snapshot }: { snapshot: ChatStreamSnapshot }) {
  return (
    <Message>
      <MessageContent className="w-full text-sm">
        {snapshot.reasoning ? <ReasoningBlock text={snapshot.reasoning} defaultOpen /> : null}
        {snapshot.tools.map((tool) => <ToolChip key={tool.id} name={tool.name} status={tool.status} />)}
        {snapshot.text ? (
          <p className="whitespace-pre-wrap">{snapshot.text}</p>
        ) : !snapshot.reasoning ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </MessageContent>
    </Message>
  );
}

/**
 * 流式过程中用纯文本渲染，结束后才走 Markdown。
 * 因为半截的 Markdown（比如刚输出到 ``` 还没闭合）渲染出来会一直闪。
 */
function AssistantBody({ content, html }: { content: string; html: string }) {
  if (!html) return <p className="whitespace-pre-wrap">{content}</p>;
  return (
    <div
      className="[&_a]:underline [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_h1]:mt-3 [&_h1]:font-medium [&_h2]:mt-3 [&_h2]:font-medium [&_h3]:mt-3 [&_h3]:font-medium [&_li]:ml-4 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-secondary [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ReasoningBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="mb-2 rounded-lg bg-secondary text-xs">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-muted-foreground">
        <BrainCircuit className="mr-1 inline size-3" />推理过程
      </summary>
      <p className="whitespace-pre-wrap px-2.5 pb-2.5 text-muted-foreground">{text}</p>
    </details>
  );
}

function ToolChip({ name, status }: { name: string; status: string }) {
  return (
    <span className="mb-2 mr-1.5 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
      <Wrench className="size-3" />
      {name}
      {status === "in_progress" ? <Loader2 className="size-3 animate-spin" /> : null}
    </span>
  );
}
