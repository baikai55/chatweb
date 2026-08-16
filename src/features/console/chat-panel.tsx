import { ArrowUp, BrainCircuit, Globe, Loader2, Square, TriangleAlert, Wrench } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

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
import { streamChatCompletions, inferVendor } from "@/transport/chat-completions";
import { isAbortError } from "@/transport/errors";
import type { ChatStreamSnapshot, ReasoningEffort } from "@/transport/types";
import { createMessageId, type ChatSession, type ConversationMessage } from "@/features/console/chat-store";
import { renderAssistantMarkup } from "@/features/console/markdown";
import { ModelPicker } from "@/features/console/model-picker";
import { notifyTaskDone, shouldSubmitOnKey, useAppSettings } from "@/shared/settings/app-settings";
import { cn } from "@/shared/lib/cn";

const REASONING_LEVELS: ReasoningEffort[] = ["auto", "none", "low", "medium", "high", "xhigh"];

export function ChatPanel({
  backend,
  models,
  session,
  onCommit,
  onManage,
}: {
  backend: Backend;
  /** 已经过滤成"用户保存过的"，可能为空 */
  models: CatalogModel[];
  session: ChatSession;
  onCommit: (session: ChatSession) => void;
  onManage: () => void;
}) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<ChatStreamSnapshot | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const settings = useAppSettings();

  const model = models.some((item) => item.id === session.model) ? session.model : models[0]?.id ?? "";
  const activeModel = models.find((item) => item.id === model);
  const vendor = inferVendor(model);
  const supportsSearch = vendor === "gemini" || vendor === "grok";

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  async function send(messages: ConversationMessage[], base: ChatSession) {
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setStreaming({ text: "", reasoning: "", tools: [] });

    try {
      const result = await streamChatCompletions({
        baseURL: backend.baseURL,
        apiKey: backend.apiKey,
        model: base.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        reasoningEffort: base.reasoningEffort,
        webSearch: base.webSearch,
        flavor: backend.flavor,
        vendor: inferVendor(base.model),
        onUpdate: setStreaming,
        signal: controller.signal,
      });

      onCommit({
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
      });
      notifyTaskDone("回复完成", result.text.slice(0, 120) || base.model);
    } catch (caught) {
      // 用户主动停止不算错误，但已经流出来的内容要保留下来
      if (isAbortError(caught)) {
        setStreaming((snapshot) => {
          if (snapshot && (snapshot.text || snapshot.reasoning)) {
            onCommit({
              ...base,
              messages: [...messages, {
                id: createMessageId(),
                role: "assistant",
                content: snapshot.text,
                reasoning: snapshot.reasoning || undefined,
              }],
              updatedAt: Date.now(),
            });
          }
          return null;
        });
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      // 用户消息也要留住，否则报错后输入的内容就白打了
      onCommit({ ...base, messages, updatedAt: Date.now() });
    } finally {
      abortRef.current = null;
      setStreaming(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || streaming || !model) return;
    const userMessage: ConversationMessage = { id: createMessageId(), role: "user", content: text };
    const base = { ...session, model };
    setInput("");
    void send([...base.messages, userMessage], base);
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
      html: message.role === "assistant" ? renderAssistantMarkup(message.content) : "",
    })),
    [session.messages],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <ModelPicker
          models={models}
          value={model}
          onChange={(id) => onCommit({ ...session, model: id })}
          onManage={onManage}
        />

        {activeModel?.reasoning ? (
          <Select
            value={session.reasoningEffort}
            onValueChange={(value) => onCommit({ ...session, reasoningEffort: value as ReasoningEffort })}
          >
            <SelectTrigger className="h-8 w-auto gap-1 rounded-full border-0 bg-transparent px-2.5 text-xs shadow-none">
              <BrainCircuit className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REASONING_LEVELS.map((level) => (
                <SelectItem key={level} value={level} className="text-xs">{level}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {supportsSearch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("size-8 rounded-full", session.webSearch && "bg-accent text-foreground")}
                onClick={() => onCommit({ ...session, webSearch: !session.webSearch })}
              >
                <Globe className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              联网搜索{vendor === "gemini" ? "" : "（仅部分模型支持）"}
            </TooltipContent>
          </Tooltip>
        ) : null}
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
                  <ChatBubble message={message} html={html} />
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

      <form onSubmit={submit} className="shrink-0 px-3 pb-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2 overflow-hidden rounded-2xl border bg-card p-2 transition-colors focus-within:border-border-hover">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={models.length === 0 ? "先去设置里保存几个模型" : "说点什么…"}
            rows={1}
            disabled={models.length === 0}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          {streaming ? (
            <Button type="button" size="icon" className="size-9 shrink-0 rounded-full" onClick={stop}>
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon" className="size-9 shrink-0 rounded-full" disabled={!input.trim() || !model}>
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
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

function ChatBubble({ message, html }: { message: ConversationMessage; html: string }) {
  if (message.role === "user") {
    return (
      <Message align="end">
        <MessageContent className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-sm">
          {message.content}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message>
      <MessageContent className="w-full text-sm">
        {message.reasoning ? <ReasoningBlock text={message.reasoning} /> : null}
        {message.tools?.map((tool) => <ToolChip key={tool.id} name={tool.name} status={tool.status} />)}
        <AssistantBody content={message.content} html={html} />
      </MessageContent>
    </Message>
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
