import { ArrowUp, BrainCircuit, Copy, Globe, Loader2, RefreshCw, Square, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
  /**
   * 哪条消息露出了操作按钮。
   *
   * 移动端没有 hover，按钮要么一直挂在那儿（每条消息都挂三个图标，很吵），
   * 要么点一下才出来。选后者：点消息展开，点别处收起。
   * 桌面端 hover 也照样能出，两种输入方式各走各的。
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const settings = useAppSettings();

  const model = models.some((item) => item.id === session.model) ? session.model : models[0]?.id ?? "";
  const activeModel = models.find((item) => item.id === model);
  const search = webSearchNote(model);

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

  async function copyMessage(text: string) {
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
    if (streaming) return;
    setSelectedId(null);
    const index = session.messages.findIndex((message) => message.id === id);
    if (index < 0) return;
    const target = session.messages[index];
    const kept = session.messages.slice(0, target.role === "user" ? index + 1 : index);
    if (kept.length === 0) return;
    const base = { ...session, model };
    void send(kept, base);
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
    /* 点消息以外的任何地方都收起操作按钮 —— 不用另外找"取消"的地方 */
    <div className="flex h-full flex-col" onClick={() => setSelectedId(null)}>
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
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
                    onRegenerate={streaming ? undefined : () => regenerateFrom(message.id)}
                    onDelete={streaming ? undefined : () => deleteMessage(message.id)}
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

function ChatBubble({
  message,
  html,
  ...actions
}: { message: ConversationMessage; html: string } & BubbleActions) {
  const body = message.role === "user" ? (
    <MessageContent className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-sm">
      {message.content}
    </MessageContent>
  ) : (
    <MessageContent className="w-full text-sm">
      {message.reasoning ? <ReasoningBlock text={message.reasoning} /> : null}
      {message.tools?.map((tool) => <ToolChip key={tool.id} name={tool.name} status={tool.status} />)}
      <AssistantBody content={message.content} html={html} />
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
