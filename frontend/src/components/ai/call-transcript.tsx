"use client";

import {
  Bookmark,
  Captions,
  Check,
  CircleAlert,
  Copy,
  Gavel,
  KanbanSquare,
  ListChecks,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Board, BoardCard } from "@/components/board/types";
import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { AI_SETUP_HINT as LIB_AI_SETUP_HINT, aiGateCopy, aiGateMessage, toAIError, useAIGate } from "@/lib/ai";
import { api, ApiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { decodeMentions } from "@/lib/format";
import { productivity } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { asCaptionEvent } from "./call-captions";

/** Kept for older imports. */
export const AI_SETUP_HINT = LIB_AI_SETUP_HINT;

/** Why call summaries are unavailable, with copy for the current viewer. */
function useCallAIGate() {
  const gate = useAIGate("captions_summary");
  const message = gate.reason ? aiGateMessage(gate.reason, gate.canConfigure) : null;
  return { ...gate, message };
}

// -------------------------------------------------------------------------------------------------
// AI call summary (POST /calls/{id}/ai/summary), kept per call across tab switches
// -------------------------------------------------------------------------------------------------

export type CallActionItem = { title: string; assignee_id: string | null };
export type CallAISummary = { summary: string; decisions: string[]; action_items: CallActionItem[] };
type SummaryState =
  | { status: "idle" }
  | { status: "loading"; prev: CallAISummary | null }
  | { status: "done"; data: CallAISummary }
  | { status: "error"; error: string; prev: CallAISummary | null };

const IDLE: SummaryState = { status: "idle" };
const summaries = new Map<string, SummaryState>();
const summaryListeners = new Set<() => void>();
const emitSummary = () => summaryListeners.forEach((fn) => fn());

function setSummary(callId: string, s: SummaryState) {
  summaries.set(callId, s);
  emitSummary();
}

function normalizeSummary(raw: unknown): CallAISummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
  const items = Array.isArray(r.action_items) ? r.action_items : [];
  return {
    summary: typeof r.summary === "string" ? r.summary : "",
    decisions: strs(r.decisions),
    action_items: items
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return {
          title: typeof o.title === "string" ? o.title : "",
          assignee_id: typeof o.assignee_id === "string" ? o.assignee_id : null,
        };
      })
      .filter((it) => it.title.trim()),
  };
}

/** Generate (or regenerate) the AI summary of a call. Safe to call from any event handler. */
export function requestCallSummary(callId: string) {
  const cur = summaries.get(callId) ?? IDLE;
  if (cur.status === "loading") return;
  const prev = cur.status === "done" ? cur.data : cur.status === "error" ? cur.prev : null;
  setSummary(callId, { status: "loading", prev });
  api<unknown>(`/calls/${callId}/ai/summary`, { method: "POST" })
    .then((raw) => setSummary(callId, { status: "done", data: normalizeSummary(raw) }))
    .catch((err) => {
      let error = errorMessage(err, "Couldn't summarize the call");
      if (err instanceof ApiError) {
        // Policy / feature 403s and "not configured" toast and refresh the shared AI status.
        const aiErr = toAIError(err);
        if (aiErr.code === "ai_not_configured" || aiErr.code === "policy" || aiErr.code === "feature_disabled") {
          error = aiErr.message;
        } else if (err.status === 429) error = "You're using AI a lot right now. Try again in a few minutes.";
        else if (err.status === 403) error = "Only channel members can summarize this call.";
        else if (err.status === 422 || err.status === 409)
          error = err.message && err.message !== "Unprocessable Entity" ? err.message : "There isn't enough in this call to summarize yet.";
      }
      setSummary(callId, { status: "error", error, prev });
    });
}

function subscribeSummary(fn: () => void) {
  summaryListeners.add(fn);
  return () => {
    summaryListeners.delete(fn);
  };
}

export function useCallSummary(callId: string): SummaryState {
  return useSyncExternalStore(
    subscribeSummary,
    () => summaries.get(callId) ?? IDLE,
    () => IDLE,
  );
}

// -------------------------------------------------------------------------------------------------
// Transcript
// -------------------------------------------------------------------------------------------------

export type TranscriptSegment = { user_id: string; text: string; ts: string };

const tsMs = (ts: string) => {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
};
// Events and GET format the same instant differently ("+00:00" vs "Z"), so key on the parsed time.
const segKey = (s: TranscriptSegment) => `${s.user_id}|${tsMs(s.ts)}|${s.text.split(/\s+/).join(" ")}`;
const timeLabel = (ts: string) => {
  const n = tsMs(ts);
  return n ? new Date(n).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
};

function mergeSegments(a: TranscriptSegment[], b: TranscriptSegment[]): TranscriptSegment[] {
  const seen = new Set(a.map(segKey));
  const out = a.slice();
  for (const s of b) {
    const k = segKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.sort((x, y) => tsMs(x.ts) - tsMs(y.ts));
}

type Group = { userId: string; start: string; items: TranscriptSegment[] };

function groupSegments(segs: TranscriptSegment[]): Group[] {
  const groups: Group[] = [];
  for (const s of segs) {
    const last = groups[groups.length - 1];
    const lastItem = last?.items[last.items.length - 1];
    if (last && last.userId === s.user_id && lastItem && tsMs(s.ts) - tsMs(lastItem.ts) < 90_000) last.items.push(s);
    else groups.push({ userId: s.user_id, start: s.ts, items: [s] });
  }
  return groups;
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const q = query.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(
      <mark key={k++} className="rounded-[3px] bg-amber-300/30 px-0.5 text-inherit">
        {text.slice(j, j + q.length)}
      </mark>,
    );
    i = j + q.length;
  }
  return <>{parts.map((p, n) => (typeof p === "string" ? <Fragment key={`t${n}`}>{p}</Fragment> : p))}</>;
}

/**
 * The call side panel's Transcript tab: the AI summary action on top, then a live list of final
 * caption segments (GET /calls/{id}/transcript + `call.caption` events) with search and copy.
 */
export function CallTranscriptPanel({
  callId,
  channelId,
  ended,
  captionsOn,
  onEnableCaptions,
}: {
  callId: string;
  channelId: string;
  ended: boolean;
  captionsOn: boolean;
  onEnableCaptions?: () => void;
}) {
  return (
    <TranscriptBody
      key={callId}
      callId={callId}
      channelId={channelId}
      ended={ended}
      captionsOn={captionsOn}
      onEnableCaptions={onEnableCaptions}
    />
  );
}

function TranscriptBody({
  callId,
  channelId,
  ended,
  captionsOn,
  onEnableCaptions,
}: {
  callId: string;
  channelId: string;
  ended: boolean;
  captionsOn: boolean;
  onEnableCaptions?: () => void;
}) {
  const { me, memberById } = useWorkspace();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let live = true;
    api<TranscriptSegment[]>(`/calls/${callId}/transcript`)
      .then((rows) => {
        if (!live) return;
        const clean = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.text === "string" && r.text.trim());
        setSegments((cur) => mergeSegments(cur, clean));
        setLoaded(true);
        setError("");
      })
      .catch((err) => {
        if (!live) return;
        setLoaded(true);
        setError(errorMessage(err, "Couldn't load the transcript"));
      });
    return () => {
      live = false;
    };
  }, [callId, attempt]);

  useWorkspaceEvents((raw) => {
    const e = raw as unknown as { type: string };
    if (e.type === "resync") {
      setAttempt((n) => n + 1);
      return;
    }
    const ev = asCaptionEvent(e);
    if (!ev || ev.call_id !== callId || !ev.final || !ev.text.trim()) return;
    const seg = { user_id: ev.user_id, text: ev.text.trim(), ts: ev.ts || new Date().toISOString() };
    setSegments((cur) => mergeSegments(cur, [seg]));
  });

  // Follow the newest line unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  const nameOf = (id: string) => (id === me?.id ? "You" : (memberById[id]?.full_name ?? "Someone"));
  const q = query.trim();
  const shown = q ? segments.filter((s) => s.text.toLocaleLowerCase().includes(q.toLocaleLowerCase())) : segments;
  const groups = groupSegments(shown);

  async function copyAll() {
    if (!segments.length) return;
    const text = segments
      .map((s) => `[${timeLabel(s.ts)}] ${memberById[s.user_id]?.full_name ?? "Someone"}: ${s.text}`)
      .join("\n");
    try {
      await copyText(text);
      toast.success("Transcript copied");
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't copy the transcript"));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CallSummaryCard callId={callId} channelId={channelId} live={!ended} hasTranscript={segments.length > 0} />

      <div className="flex items-center gap-1.5 border-b px-2 py-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-muted px-2 ring-1 ring-transparent focus-within:ring-ring/60">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search transcript"
            aria-label="Search transcript"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => void copyAll()}
          disabled={!segments.length}
          title="Copy the whole transcript"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-foreground/85 outline-none ring-1 ring-border transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40"
        >
          <Copy className="size-3.5" aria-hidden />
          Copy all
        </button>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        role="log"
        aria-label="Call transcript"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!loaded ? (
          <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading transcript">
            {[80, 60, 72].map((w) => (
              <div key={w} className="flex gap-2.5">
                <div className="size-8 shrink-0 rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5 pt-1">
                  <div className="h-2.5 w-24 rounded bg-muted" />
                  <div className="h-3 rounded bg-muted" style={{ width: `${w}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : error && !segments.length ? (
          <div className="m-auto max-w-xs py-8 text-center">
            <CircleAlert className="mx-auto mb-2 size-7 text-muted-foreground" aria-hidden />
            <p className="text-sm font-bold">Couldn&apos;t load the transcript</p>
            <p className="mb-3 text-xs text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError("");
                setAttempt((n) => n + 1);
              }}
              className="rounded-md border px-3 py-1.5 text-sm font-bold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Try again
            </button>
          </div>
        ) : !segments.length ? (
          <div className="mx-auto flex max-w-[16rem] flex-col items-center py-8 text-center">
            <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-white/[0.06] ring-1 ring-white/10">
              <ScrollText className="size-5 text-muted-foreground" aria-hidden />
            </span>
            <p className="text-sm font-bold">No transcript yet</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {ended
                ? "Nobody had live captions on during this call."
                : "Everyone who turns on live captions (CC) adds what they say here, as they say it."}
            </p>
            {!ended && !captionsOn && onEnableCaptions && (
              <button
                type="button"
                onClick={onEnableCaptions}
                className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-bold text-zinc-900 outline-none hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <Captions className="size-3.5" aria-hidden />
                Turn on captions
              </button>
            )}
          </div>
        ) : !groups.length ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No lines match &ldquo;{q}&rdquo;.</p>
        ) : (
          <ol className="space-y-3.5">
            {groups.map((g) => (
              <li key={`${g.userId}|${g.start}`} className="flex gap-2.5">
                <UserAvatar id={g.userId} name={memberById[g.userId]?.full_name ?? "Someone"} size="md" className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-bold">{nameOf(g.userId)}</span>
                    <time dateTime={g.start} className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {timeLabel(g.start)}
                    </time>
                  </p>
                  {g.items.map((s) => (
                    <p key={segKey(s)} className="text-[13.5px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
                      <Highlight text={s.text} query={q} />
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// ✨ Summarize call
// -------------------------------------------------------------------------------------------------

const AI_GRADIENT = "bg-gradient-to-r from-violet-500 to-indigo-500";

/** The "✨ Summarize call" button. Disabled, with an explanation, when AI isn't configured. */
export function SummarizeCallButton({
  callId,
  live = false,
  className,
  onRequested,
}: {
  callId: string;
  /** Summaries are made once the call ends; while live the button explains that instead. */
  live?: boolean;
  className?: string;
  onRequested?: () => void;
}) {
  const gate = useCallAIGate();
  const enabled = gate.loading ? null : gate.ready;
  const state = useCallSummary(callId);
  const loading = state.status === "loading";
  const off = enabled === false;
  const title = off
    ? (gate.message ?? undefined)
    : live
      ? "Available when the call ends. Worklio AI also posts a summary to the call thread automatically."
      : undefined;
  const hasResult = state.status === "done";
  return (
    <button
      type="button"
      onClick={() => {
        requestCallSummary(callId);
        onRequested?.();
      }}
      disabled={off || live || loading || enabled === null}
      title={title}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-white outline-none transition focus-visible:ring-2 focus-visible:ring-violet-200/70 disabled:cursor-not-allowed",
        off || live ? "bg-white/[0.08] text-white/50" : `${AI_GRADIENT} shadow-[0_8px_24px_-10px_rgb(139_92_246/0.9)] hover:brightness-110`,
        loading && "opacity-80",
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : hasResult ? <RefreshCw className="size-3.5" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
      {loading ? "Summarizing…" : hasResult ? "Regenerate" : "Summarize call"}
    </button>
  );
}

type ItemState = "idle" | "busy" | "done";

function CallSummaryCard({
  callId,
  channelId,
  live,
  hasTranscript,
}: {
  callId: string;
  channelId: string;
  live: boolean;
  hasTranscript: boolean;
}) {
  const gate = useCallAIGate();
  const enabled = gate.loading ? null : gate.ready;
  const copy = gate.reason ? aiGateCopy(gate.reason, gate.canConfigure) : null;
  const state = useCallSummary(callId);
  const [collapsed, setCollapsed] = useState(false);
  const data = state.status === "done" ? state.data : state.status === "loading" || state.status === "error" ? state.prev : null;

  return (
    <section
      aria-label="Worklio AI call summary"
      className="relative border-b px-3 py-2.5 before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(420px_120px_at_0%_0%,rgb(139_92_246/0.14),transparent_70%)]"
    >
      <div className="relative flex items-center gap-2">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-lg text-white", AI_GRADIENT)} aria-hidden>
          <Sparkles className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-bold">Worklio AI</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {copy
              ? copy.title
              : data
                ? "Summary, decisions and action items"
                : live
                  ? "Summarize when the call ends"
                  : hasTranscript
                  ? "Summarize the transcript and notes"
                  : "Summarizes the transcript and call notes"}
          </p>
        </div>
        {data && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="h-7 shrink-0 rounded-md px-2 text-[11.5px] font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        )}
        <SummarizeCallButton callId={callId} live={live} onRequested={() => setCollapsed(false)} />
      </div>

      {copy && (
        <div className="relative mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11.5px] leading-snug text-muted-foreground ring-1 ring-white/[0.06]">
          <span>{copy.body}</span>
          {copy.cta && (
            <Link
              href={gate.settingsHref}
              className="inline-flex items-center gap-1 font-semibold text-violet-300 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-violet-300/60"
            >
              <Settings2 className="size-3.5" aria-hidden /> {gate.reason === "not_configured" ? "Set up Worklio AI" : "Open AI settings"}
            </Link>
          )}
        </div>
      )}

      {live && enabled !== false && !data && (
        <p className="relative mt-2 text-[11.5px] leading-snug text-muted-foreground">
          When the call ends, Worklio AI posts a summary with decisions and action items to the call thread. Turn on
          captions or take notes so it has something to work with.
        </p>
      )}

      {state.status === "error" && (
        <p role="alert" className="relative mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-red-300">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {state.error}
        </p>
      )}

      {state.status === "loading" && !data && (
        <div className="relative mt-2.5 space-y-1.5" aria-busy="true" aria-label="Summarizing the call">
          {[92, 78, 64].map((w) => (
            <div
              key={w}
              className="h-2.5 animate-pulse rounded bg-gradient-to-r from-violet-400/25 to-indigo-400/15"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      )}

      {data && !collapsed && (
        <div className={cn("relative mt-2.5 max-h-[45vh] overflow-y-auto pr-1", state.status === "loading" && "opacity-60")}>
          <SummaryBody data={data} channelId={channelId} />
        </div>
      )}
    </section>
  );
}

function SummaryBody({ data, channelId }: { data: CallAISummary; channelId: string }) {
  const { workspaceId, memberById } = useWorkspace();
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const decode = (t: string) => decodeMentions(t, memberById);
  const set = (key: string, s: ItemState) => setItems((m) => ({ ...m, [key]: s }));

  async function addToLater(item: CallActionItem, key: string) {
    set(key, "busy");
    try {
      await productivity.createLater(workspaceId, { title: decode(item.title), notes: "From the AI call summary" });
      set(key, "done");
      toast.success("Added to Later");
    } catch (err) {
      set(key, "idle");
      toast.error(errorMessage(err, "Couldn't add to Later"));
    }
  }

  async function addToBoard(item: CallActionItem, key: string) {
    set(key, "busy");
    try {
      const board = await api<Board>(`/channels/${channelId}/board`);
      const column = [...(board.columns ?? [])].sort((a, b) => a.position - b.position)[0];
      if (!column) throw new Error("This channel's board has no columns yet.");
      await api<BoardCard>(`/channels/${channelId}/board/cards`, {
        method: "POST",
        body: JSON.stringify({
          column_id: column.id,
          title: decode(item.title),
          ...(item.assignee_id ? { assignee_id: item.assignee_id } : {}),
        }),
      });
      set(key, "done");
      toast.success(`Added to the board in “${column.name}”`);
    } catch (err) {
      set(key, "idle");
      toast.error(errorMessage(err, "Couldn't add to the board"));
    }
  }

  async function copySummary() {
    const lines = [
      data.summary && decode(data.summary),
      data.decisions.length ? `\nDecisions:\n${data.decisions.map((d) => `• ${decode(d)}`).join("\n")}` : "",
      data.action_items.length
        ? `\nAction items:\n${data.action_items
            .map((a) => `• ${decode(a.title)}${a.assignee_id ? ` (${memberById[a.assignee_id]?.full_name ?? "someone"})` : ""}`)
            .join("\n")}`
        : "",
    ].filter(Boolean);
    try {
      await copyText(lines.join("\n"));
      toast.success("Summary copied");
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't copy"));
    }
  }

  return (
    <div className="space-y-3 text-[13px] leading-relaxed">
      {data.summary && (
        <div className="space-y-1.5 text-foreground/90">
          {decode(data.summary)
            .split(/\n{2,}|\n/)
            .filter((p) => p.trim())
            .map((p, i) => (
              <p key={i} className="[overflow-wrap:anywhere]">
                {p.replace(/^#+\s*/, "").replace(/\*\*(.+?)\*\*/g, "$1")}
              </p>
            ))}
        </div>
      )}

      {data.decisions.length > 0 && (
        <div>
          <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
            <Gavel className="size-3" aria-hidden /> Decisions
          </h4>
          <ul className="space-y-1">
            {data.decisions.map((d, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-violet-400" />
                <span className="[overflow-wrap:anywhere]">{decode(d)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.action_items.length > 0 && (
        <div>
          <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
            <ListChecks className="size-3" aria-hidden /> Action items
          </h4>
          <ul className="space-y-1.5">
            {data.action_items.map((a, i) => {
              const key = `${i}|${a.title}`;
              const later = items[`later|${key}`] ?? "idle";
              const board = items[`board|${key}`] ?? "idle";
              const assignee = a.assignee_id ? memberById[a.assignee_id] : undefined;
              return (
                <li key={key} className="rounded-xl bg-white/[0.04] px-2.5 py-2 ring-1 ring-white/[0.06]">
                  <p className="font-medium [overflow-wrap:anywhere]">{decode(a.title)}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {a.assignee_id && (
                      <span className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        <UserAvatar id={a.assignee_id} name={assignee?.full_name ?? "Someone"} size="xs" />
                        <span className="truncate">{assignee?.full_name ?? "Someone"}</span>
                      </span>
                    )}
                    <ItemAction
                      state={later}
                      onClick={() => void addToLater(a, `later|${key}`)}
                      icon={Bookmark}
                      label="Later"
                      doneLabel="Saved"
                    />
                    <ItemAction
                      state={board}
                      onClick={() => void addToBoard(a, `board|${key}`)}
                      icon={KanbanSquare}
                      label="Board"
                      doneLabel="On board"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!data.summary && !data.decisions.length && !data.action_items.length && (
        <p className="text-muted-foreground">Nothing to summarize yet.</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Sparkles className="size-3 text-violet-300" aria-hidden />
          AI can make mistakes. Check important details.
        </span>
        <button
          type="button"
          onClick={() => void copySummary()}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1 font-semibold outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Copy className="size-3" aria-hidden /> Copy
        </button>
      </div>
    </div>
  );
}

function ItemAction({
  state,
  onClick,
  icon: Icon,
  label,
  doneLabel,
}: {
  state: ItemState;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  doneLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state !== "idle"}
      aria-label={state === "done" ? doneLabel : `Add to ${label}`}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-semibold outline-none ring-1 transition focus-visible:ring-2 focus-visible:ring-ring/60",
        state === "done"
          ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/20"
          : "bg-white/[0.06] text-foreground/85 ring-white/10 hover:bg-white/[0.12] disabled:opacity-60",
      )}
    >
      {state === "busy" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : state === "done" ? (
        <Check className="size-3" aria-hidden />
      ) : (
        <Icon className="size-3" aria-hidden />
      )}
      {state === "done" ? doneLabel : label}
    </button>
  );
}
