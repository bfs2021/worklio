"use client";

import {
  ArrowUp,
  Check,
  ChevronLeft,
  Copy,
  History,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { ai, aiErrorMessage, aiModelLabel, aiPaths, isGateError, useAIGate, type AICitation, type AIConversation, type AIErrorCode } from "@/lib/ai";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { AIMarkdown } from "./ai-markdown";
import { AIModelChip, AISettingsButton } from "./ai-settings-button";
import { closeAsk, onAskPrompt, openAsk, toggleAsk, useAIUI } from "./ai-store";
import { AI_ASK_EVENT } from "./composer-assistant";
import {
  AIAvatar,
  AIDisabledState,
  AIDisclaimer,
  AIErrorNote,
  AISparkle,
  AIStatusLine,
  AI_GRADIENT_TEXT,
  AI_SURFACE,
  gateFromError,
} from "./brand";
import { CitationList, useJumpToCitation } from "./citations";
import { MessageAIOverlays } from "./message-ai-overlays";
import { useAICopy } from "./streamed-answer";
import { useAIStream } from "./use-ai-stream";

/**
 * Ask Worklio: a chat with Worklio AI about the workspace. Answers come only from messages the
 * asker can read (the server searches with their permissions) and cite their sources.
 *
 * Mount <AskWorklioPanel/> once inside the workspace shell (it also hosts the message-action AI
 * overlays) and put <AskWorklioButton/> in the top bar. ⌘J / Ctrl+J toggles the panel.
 */

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations: AICitation[];
  error?: { code: AIErrorCode; message: string } | null;
  stopped?: boolean;
  /** The question this answer replies to (for "Try again"). */
  question?: string;
};

let turnSeq = 0;
const newId = () => `t${++turnSeq}`;

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

/** Top-bar button. Styled for the chrome bar by default; pass `className` to restyle. */
export function AskWorklioButton({ className, showLabel = true }: { className?: string; showLabel?: boolean }) {
  const open = useAIUI((s) => s.askOpen);
  return (
    <button
      type="button"
      onClick={() => toggleAsk()}
      aria-pressed={open}
      aria-label="Ask Worklio"
      title="Ask Worklio (⌘J)"
      className={cn(
        "group relative flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-chrome-foreground transition-colors hover:bg-chrome-hover md:h-7",
        open && "bg-chrome-hover",
        className,
      )}
    >
      <span className="flex size-5 items-center justify-center rounded-[6px] bg-gradient-to-br from-violet-400 to-indigo-500 shadow-sm shadow-violet-500/40 transition-transform group-hover:scale-105">
        <AISparkle className="size-3 text-white dark:text-white" />
      </span>
      {showLabel && <span className="hidden lg:inline">Ask</span>}
    </button>
  );
}

export function AskWorklioPanel() {
  const open = useAIUI((s) => s.askOpen);

  // ⌘J / Ctrl+J toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "j" && e.code !== "KeyJ") return;
      e.preventDefault();
      toggleAsk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "/ai <question>" in the composer dispatches "worklio:ask" ({question}); a bare "/ai" just opens.
  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = String((e as CustomEvent<{ question?: string }>).detail?.question ?? "").trim();
      openAsk(q || undefined, !!q);
    };
    window.addEventListener(AI_ASK_EVENT, onAsk);
    return () => window.removeEventListener(AI_ASK_EVENT, onAsk);
  }, []);

  return (
    <>
      <AskPanelBody open={open} />
      <MessageAIOverlays />
    </>
  );
}

const OVERLAY_SELECTOR =
  "[data-slot=popover-content],[data-slot=dropdown-menu-content],[data-slot=dialog-content],[data-slot=sheet-content],[role=menu],[role=listbox]";

/** Kept mounted while closed so the conversation survives closing and reopening. */
function AskPanelBody({ open }: { open: boolean }) {
  const ws = useWorkspace();
  const gate = useAIGate("ask");
  const status = gate.status;
  const stream = useAIStream();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "history">("chat");
  const [history, setHistory] = useState<AIConversation[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const busyRef = useRef(false);
  const convRef = useRef<string | null>(null);
  /** Bumped by "New chat" / opening another chat, so a finishing answer can't land in the wrong one. */
  const epochRef = useRef(0);
  useEffect(() => {
    convRef.current = conversationId;
  });

  const jumpBase = useJumpToCitation();
  const jump = (c: AICitation) => {
    jumpBase(c);
    if (isPhone()) closeAsk();
  };

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || busyRef.current) return;
    busyRef.current = true;
    stick.current = true;
    setView("chat");
    setInput("");
    setTurns((t) => [...t, { id: newId(), role: "user", text: question, citations: [] }]);
    setLiveQuestion(question);
    const epoch = epochRef.current;
    const r = await stream.start(aiPaths.ask(ws.workspaceId), { question, ...(convRef.current ? { conversation_id: convRef.current } : {}) });
    if (epoch !== epochRef.current) return;
    busyRef.current = false;
    // Commit the answer and drop the live view in one render.
    setLiveQuestion(null);
    setTurns((t) => [
      ...t,
      { id: newId(), role: "assistant", text: r.text, citations: r.citations, error: r.error, stopped: r.stopped, question },
    ]);
    if (r.conversationId) {
      if (r.conversationId !== convRef.current) setTitle(question.length > 60 ? `${question.slice(0, 57)}…` : question);
      setConversationId(r.conversationId);
      setHistory(null); // refetch next time the list opens
    }
  };
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });

  // Prompts pushed by openAsk(prompt, send) from elsewhere in the app.
  useEffect(
    () =>
      onAskPrompt((p) => {
        if (p.send) void sendRef.current(p.text);
        else {
          setInput(p.text);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }),
    [],
  );

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Follow the stream unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns, stream.text, stream.status, liveQuestion]);

  const newChat = () => {
    epochRef.current++;
    stream.reset();
    busyRef.current = false;
    setTurns([]);
    setLiveQuestion(null);
    setConversationId(null);
    setTitle(null);
    setView("chat");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const fetchHistory = () => {
    setHistoryError(null);
    ai.conversations(ws.workspaceId)
      .then((list) => setHistory([...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))))
      .catch((err) => setHistoryError(aiErrorMessage(err)));
  };

  const loadHistory = () => {
    setView("history");
    if (!history) fetchHistory();
  };

  const openConversation = (c: AIConversation) => {
    if (busyRef.current) stream.stop();
    setLoadingConversation(c.id);
    ai.conversation(c.id)
      .then((detail) => {
        epochRef.current++;
        busyRef.current = false;
        stream.reset();
        setTurns(detail.turns.map((t) => ({ ...t, id: newId() })));
        setLiveQuestion(null);
        setConversationId(detail.id);
        setTitle(detail.title);
        setView("chat");
        stick.current = true;
      })
      .catch((err) => toast.error(`Couldn't open that chat: ${aiErrorMessage(err)}`))
      .finally(() => setLoadingConversation(null));
  };

  const removeConversation = (c: AIConversation) => {
    const prev = history;
    setHistory((h) => h?.filter((x) => x.id !== c.id) ?? h);
    ai.deleteConversation(c.id)
      .then(() => {
        if (convRef.current === c.id) newChat();
      })
      .catch((err) => {
        setHistory(prev);
        toast.error(`Couldn't delete the chat: ${aiErrorMessage(err)}`);
      });
  };

  if (!open) return null;

  const live = liveQuestion !== null;
  const disabled = !!gate.reason;
  const generalName =
    ws.channels.find((c) => c.kind === "public" && c.name === "general")?.name ??
    ws.channels.find((c) => c.kind === "public")?.name ??
    "general";
  const someone = ws.members.find((m) => m.user_id !== ws.me?.id && m.role !== "guest")?.full_name.split(" ")[0] ?? "Bob";
  const suggestions = [
    "What did I miss today?",
    `Summarize decisions in #${generalName} this week`,
    `What is ${someone} working on?`,
  ];

  return (
    <aside
      aria-label="Ask Worklio"
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:inset-y-0 md:right-0 md:left-auto md:w-[min(460px,100vw)] md:border-l md:pt-0 md:pb-0 md:shadow-2xl md:shadow-violet-950/20"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
        if ((e.target as HTMLElement).closest?.(OVERLAY_SELECTOR)) return;
        e.preventDefault();
        if (view === "history") setView("chat");
        else closeAsk();
      }}
    >
      {/* Gradient hairline: the AI signature. */}
      <div aria-hidden className="h-0.5 shrink-0 bg-gradient-to-r from-violet-500 via-indigo-500 to-violet-500" />
      <header className={cn("flex min-h-[52px] shrink-0 items-center gap-1.5 border-b px-3 py-1.5 sm:gap-2", AI_SURFACE)}>
        {view === "history" ? (
          <button onClick={() => setView("chat")} className="rounded-md p-1.5 hover:bg-muted" aria-label="Back to chat">
            <ChevronLeft className="size-5" />
          </button>
        ) : (
          <AIAvatar className="size-7" />
        )}
        <div className="min-w-0 flex-1">
          <div className={cn("text-[15px] leading-tight font-black", AI_GRADIENT_TEXT)}>
            {view === "history" ? "Chat history" : "Ask Worklio"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {view === "history" ? "Your private chats with Worklio AI" : (title ?? "Answers from conversations you can access")}
          </div>
          {view === "chat" && !disabled && <AIModelChip status={status} className="mt-0.5" />}
        </div>
        {!disabled && (
          <>
            <IconButton label="Chat history" onClick={() => (view === "history" ? setView("chat") : loadHistory())} active={view === "history"}>
              <History className="size-[18px]" />
            </IconButton>
            <IconButton label="New chat" onClick={newChat}>
              <MessageSquarePlus className="size-[18px]" />
            </IconButton>
          </>
        )}
        <AISettingsButton />
        <IconButton label="Close (Esc)" onClick={closeAsk}>
          <X className="size-5" />
        </IconButton>
      </header>

      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {historyError ? (
            <AIErrorNote message={historyError} onRetry={fetchHistory} className="m-2" />
          ) : !history ? (
            <div className="flex justify-center p-6 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No chats yet. Ask something to get started.</p>
          ) : (
            <ul className="space-y-0.5">
              {history.map((c) => (
                <li key={c.id} className="group flex items-center gap-1 rounded-lg hover:bg-muted">
                  <button
                    onClick={() => openConversation(c)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left",
                      c.id === conversationId && "font-bold",
                    )}
                  >
                    {loadingConversation === c.id ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <AISparkle className="size-3.5 opacity-70" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relative(c.updated_at)}</span>
                  </button>
                  <button
                    onClick={() => removeConversation(c)}
                    className="mr-1 rounded-md p-1.5 text-muted-foreground opacity-100 hover:bg-background hover:text-destructive md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    aria-label={`Delete chat "${c.title}"`}
                    title="Delete chat"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {disabled ? (
            <div className="p-4">
              <AIDisabledState feature="ask" />
            </div>
          ) : turns.length === 0 && !live ? (
            <Welcome suggestions={suggestions} onPick={(s) => void send(s)} model={aiModelLabel(status)} />
          ) : (
            <div className="space-y-5 px-4 py-4">
              {turns.map((t) =>
                t.role === "user" ? (
                  <UserBubble key={t.id} text={t.text} />
                ) : (
                  <AssistantTurn
                    key={t.id}
                    text={t.text}
                    citations={t.citations}
                    error={t.error ?? null}
                    stopped={t.stopped}
                    onJump={jump}
                    onRetry={t.question ? () => void send(t.question!) : undefined}
                  />
                ),
              )}
              {live && (
                <AssistantTurn
                  text={stream.text}
                  citations={stream.citations}
                  error={stream.error}
                  status={stream.status}
                  streaming={stream.streaming}
                  onJump={jump}
                />
              )}
            </div>
          )}
        </div>
      )}

      {view === "chat" && !disabled && (
        <div className="shrink-0 border-t bg-background px-3 pt-2 pb-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="flex items-end gap-2 rounded-xl border bg-background px-2 py-1.5 shadow-xs transition-shadow focus-within:border-violet-500/50 focus-within:ring-3 focus-within:ring-violet-500/15"
          >
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask about your workspace…"}
              aria-label="Ask Worklio"
              className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1 text-[15px] outline-none [field-sizing:content] placeholder:text-muted-foreground md:text-sm"
            />
            {stream.streaming ? (
              <button
                type="button"
                onClick={stream.stop}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background hover:bg-muted"
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-sm shadow-violet-500/30 transition-opacity disabled:opacity-35"
                aria-label="Send"
                title="Send (Enter)"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </form>
          <AIDisclaimer className="mt-1.5 justify-center" />
        </div>
      )}
    </aside>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}
    >
      {children}
    </button>
  );
}

function Welcome({ suggestions, onPick, model }: { suggestions: string[]; onPick: (s: string) => void; model?: string }) {
  return (
    <div className="flex min-h-full flex-col justify-end gap-5 px-4 py-6">
      <div className="space-y-2">
        <AIAvatar className="size-11 rounded-xl" />
        <h2 className="text-xl font-black">
          Hi! I&apos;m <span className={AI_GRADIENT_TEXT}>Worklio AI</span>.
        </h2>
        <p className="text-sm text-muted-foreground">
          Ask me anything about your workspace. I search the conversations you have access to and show where every
          answer came from.
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Try asking</p>
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition-colors hover:border-violet-500/40 hover:bg-violet-500/[0.05]",
            )}
          >
            <AISparkle className="size-3.5" />
            {s}
          </button>
        ))}
      </div>
      {model && <p className="text-[11px] text-muted-foreground">Powered by {model}</p>}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  const ws = useWorkspace();
  const me = ws.me;
  return (
    <div className="flex justify-end gap-2">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-[14.5px] break-words whitespace-pre-wrap">{text}</div>
      {me && <UserAvatar id={me.id} name={me.full_name} size="sm" className="mt-0.5" />}
    </div>
  );
}

function AssistantTurn({
  text,
  citations,
  error,
  status,
  streaming,
  stopped,
  onJump,
  onRetry,
}: {
  text: string;
  citations: AICitation[];
  error: { code: AIErrorCode; message: string } | null;
  status?: string | null;
  streaming?: boolean;
  stopped?: boolean;
  onJump: (c: AICitation) => void;
  onRetry?: () => void;
}) {
  const { copied, copy } = useAICopy();
  return (
    <div className="flex gap-2.5">
      <AIAvatar className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1 space-y-2">
        {streaming && status && <AIStatusLine text={status} />}
        {streaming && !text && !status && <AIStatusLine text="Thinking…" />}
        {text && <AIMarkdown text={text} citations={citations} streaming={streaming} onCite={onJump} />}
        {stopped && <p className="text-xs text-muted-foreground italic">Stopped generating.</p>}
        {error &&
          (isGateError(error.code) ? (
            <AIDisabledState compact feature="ask" reason={gateFromError(error.code)} />
          ) : (
            <AIErrorNote message={error.message} onRetry={error.code === "refusal" ? undefined : onRetry} />
          ))}
        {!streaming && citations.length > 0 && <CitationList citations={citations} onJump={onJump} max={8} />}
        {!streaming && text && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => copy(text)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            {onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="size-3.5" /> Ask again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export { openAsk };
