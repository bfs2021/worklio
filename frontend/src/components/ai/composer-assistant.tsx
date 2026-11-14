"use client";

/**
 * Worklio AI in the composer and the timeline:
 *  - AI status (re-exported from @/lib/ai), the workspace's Worklio bot user and agent installs
 *  - the ✨ rewrite menu + inline preview card used by the Composer (POST /ai/compose)
 *  - the "worklio:ask" window event that opens the Ask Worklio panel (/ai <question>)
 *  - the shared visual language: sparkle mark, "AI" badge, gradient avatar ring
 *  - the AI call summary card (system message, meta.type "call_ai_summary")
 */

import {
  ArrowDownToLine,
  Bookmark,
  BookmarkCheck,
  Briefcase,
  Check,
  CheckCircle2,
  HeartHandshake,
  KanbanSquare,
  Languages,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Replace,
  Sparkles,
  SpellCheck,
  Plus,
  Settings2,
  Wand2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useGroupsById } from "@/components/messaging/use-groups";
import { useWorkspace } from "@/components/workspace/provider";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AI_SETUP_HINT as LIB_AI_SETUP_HINT,
  AIError,
  agentInstalledIn,
  ai,
  aiGateCopy,
  aiGateMessage,
  installWorklioAgent,
  useAIGate,
  useAIStatus as useLibAIStatus,
  type AIStatus as LibAIStatus,
} from "@/lib/ai";
import { api, type Channel, type Member, type Message } from "@/lib/api";
import { formatMessage } from "@/lib/format";
import { productivity } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { UserAvatar, type AvatarSize } from "@/components/chat/user-avatar";

// ---------------------------------------------------------------------------
// Constants & events
// ---------------------------------------------------------------------------

/** Kept for older imports; the gate copy in @/lib/ai is role-aware. */
export const AI_SETUP_HINT = LIB_AI_SETUP_HINT;

/** Window event that opens the Ask Worklio panel. Detail: {question}. */
export const AI_ASK_EVENT = "worklio:ask";
export type AskEventDetail = { question: string };

/** Open the Ask Worklio panel, optionally prefilled with a question. */
export function askWorklio(question: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AskEventDetail>(AI_ASK_EVENT, { detail: { question } }));
}

/** "/ai what did we decide about pricing?" → the question ("" for a bare "/ai"); null if not /ai. */
export function parseAskCommand(text: string): string | null {
  const m = /^\/ai(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

// ---------------------------------------------------------------------------
// AI status (shared workspace store in @/lib/ai)
// ---------------------------------------------------------------------------

export type AIStatus = LibAIStatus;

/** The workspace's AI status; null while unknown (treated as "not yet enabled"). */
export function useAIStatus(): AIStatus | null {
  return useLibAIStatus().status;
}

// ---------------------------------------------------------------------------
// @worklio agent installs
// ---------------------------------------------------------------------------

type ManagedChannel = Channel & { manager_ids?: string[]; my_role?: string; role?: string; created_by?: string | null };

/** Can I manage this channel (workspace admin, or a channel manager)? Read leniently from the channel payload. */
export function canManageChannel(channel: Channel | null | undefined, meId: string | null | undefined, isAdmin: boolean): boolean {
  if (!channel || channel.kind === "dm") return false;
  if (isAdmin) return true;
  const c = channel as ManagedChannel;
  if (!meId) return false;
  return !!c.manager_ids?.includes(meId) || c.my_role === "manager" || c.role === "manager" || c.created_by === meId;
}

export type WorklioAgentState = {
  /** AI is ready for the agent (configured, allowed, agent feature on). */
  available: boolean;
  /** The agent can answer in this channel (installed here, everywhere-install for public, or a DM). */
  installed: boolean;
  /** I can add it here myself. */
  canAdd: boolean;
  adding: boolean;
  add: () => Promise<boolean>;
  channelName: string;
};

/** Whether @worklio works in `channelId`, and a way to add it (POST /channels/{id}/apps/worklio). */
export function useWorklioAgent(channelId: string): WorklioAgentState {
  const ws = useWorkspace();
  const gate = useAIGate("agent", ws.workspaceId);
  const channel = ws.channels.find((c) => c.id === channelId);
  const [adding, setAdding] = useState(false);
  const installed = gate.ready && agentInstalledIn(gate.status, channel);
  const name = channel ? ws.channelLabel(channel) : "this channel";
  const add = async () => {
    if (adding || !channel) return false;
    setAdding(true);
    const ok = await installWorklioAgent(ws.workspaceId, channel.id);
    setAdding(false);
    if (ok) toast.success(`Worklio AI added to ${channel.kind === "dm" ? name : `#${name}`}`);
    return ok;
  };
  return {
    available: gate.ready,
    installed,
    canAdd: canManageChannel(channel, ws.me?.id, ws.isAdmin),
    adding,
    add,
    channelName: name,
  };
}

/** Hint for people who can't add the agent themselves. */
export const AGENT_ADD_HINT = "Channel managers can add it from Channel details → Integrations.";

/**
 * Nudge above the composer when a draft mentions @Worklio in a channel the agent isn't in:
 * managers/admins add it in one click, everyone else sees who can.
 */
export function WorklioAddNudge({ agent, onDismiss }: { agent: WorklioAgentState; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="wk-ai-in mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-violet-500/[0.07] px-2.5 py-1.5 text-[12.5px] ring-1 ring-violet-500/20 ring-inset dark:bg-violet-400/[0.08]"
    >
      <AIStyles />
      <AISparkle className="size-4 rounded" iconClassName="size-2.5" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">Worklio AI isn&apos;t added to #{agent.channelName}</span>
        <span className="text-muted-foreground">
          {agent.canAdd ? " · it won't answer here until it's added." : ` · ${AGENT_ADD_HINT}`}
        </span>
      </span>
      {agent.canAdd && (
        <button
          type="button"
          onClick={() => void agent.add()}
          disabled={agent.adding}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-linear-to-r from-violet-600 to-indigo-600 px-2.5 text-xs font-semibold text-white shadow-sm outline-none hover:from-violet-500 hover:to-indigo-500 focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:opacity-60"
        >
          {agent.adding ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
          {agent.adding ? "Adding…" : "Add to channel"}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * The ✨ composer button when writing help isn't available to me: a popover explaining why
 * (not set up / admins only / turned off), with "Set up Worklio AI" for admins.
 */
export function AIComposeUnavailableButton({
  open,
  onOpenChange,
  triggerClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerClassName?: string;
}) {
  const gate = useAIGate("composer");
  const reason = gate.reason ?? "not_configured";
  const copy = aiGateCopy(reason, gate.canConfigure);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={`Worklio AI: ${aiGateMessage(reason, gate.canConfigure)}`}
        className={cn(
          "shrink-0 rounded p-2 text-muted-foreground/45 outline-none hover:bg-muted hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-popup-open:bg-muted sm:p-1.5",
          triggerClassName,
        )}
      >
        <Sparkles className="size-[18px]" aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(18rem,calc(100vw-2rem))] gap-2 p-3">
        <div className="flex items-center gap-1.5">
          <AISparkle className="size-4 rounded" iconClassName="size-2.5" />
          <span className="text-[13px] font-bold">{copy.title}</span>
        </div>
        <p className="text-[13px] text-muted-foreground">{copy.body}</p>
        {copy.cta && (
          <Link
            href={gate.settingsHref}
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 w-fit items-center gap-1.5 rounded-lg bg-linear-to-r from-violet-600 to-indigo-600 px-3 text-[13px] font-semibold text-white shadow-sm outline-none hover:from-violet-500 hover:to-indigo-500 focus-visible:ring-2 focus-visible:ring-violet-500/50"
          >
            <Settings2 className="size-3.5" aria-hidden /> {reason === "not_configured" ? "Set up Worklio AI" : "Open AI settings"}
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Worklio bot user (GET /workspaces/{id}/ai/bot)
// ---------------------------------------------------------------------------

type BotMember = Member;

/** MemberOut.is_bot marks the workspace's Worklio AI bot user. */
export const isBotMember = (m: Member | null | undefined): boolean => !!m?.is_bot;

let botIds: Record<string, string | null> = {};
const botRequested = new Set<string>();
const botListeners = new Set<() => void>();

function ensureBot(workspaceId: string) {
  if (botRequested.has(workspaceId)) return;
  botRequested.add(workspaceId);
  api<{ user_id: string }>(`/workspaces/${workspaceId}/ai/bot`)
    .then((r) => r?.user_id ?? null)
    .catch(() => null)
    .then((id) => {
      if (!id) botRequested.delete(workspaceId); // try again on a later mount
      botIds = { ...botIds, [workspaceId]: id };
      botListeners.forEach((fn) => fn());
    });
}

function subscribeBot(fn: () => void) {
  botListeners.add(fn);
  return () => {
    botListeners.delete(fn);
  };
}

/**
 * The workspace's Worklio bot as a mentionable member: the real member row when the members list
 * includes it, else a stand-in built from GET /ai/bot. null when AI is off or there's no bot.
 */
export function useWorklioBot(workspaceId: string, members: Member[]): Member | null {
  // Only suggest @worklio when AI is configured, allowed for me and the agent feature is on.
  const enabled = useAIGate("agent", workspaceId).ready;
  const listed = members.find(isBotMember) ?? null;
  const fetchedId = useSyncExternalStore(
    subscribeBot,
    () => botIds[workspaceId] ?? null,
    () => null,
  );
  useEffect(() => {
    if (enabled && !listed) ensureBot(workspaceId);
  }, [enabled, listed, workspaceId]);
  const known = fetchedId ? (members.find((m) => m.user_id === fetchedId) ?? null) : null;
  return useMemo((): Member | null => {
    if (!enabled) return null;
    if (listed) return listed;
    if (!fetchedId) return null;
    if (known) return { ...known, is_bot: true } as BotMember;
    return { user_id: fetchedId, full_name: "Worklio", email: null, role: "member", is_bot: true } as BotMember;
  }, [enabled, listed, fetchedId, known]);
}

/** Is this user id a bot (member flag, or the workspace's known Worklio bot id)? */
export function useIsBotUser(): (userId: string) => boolean {
  const { memberById, workspaceId } = useWorkspace();
  const fetchedId = useSyncExternalStore(
    subscribeBot,
    () => botIds[workspaceId] ?? null,
    () => null,
  );
  return (userId: string) => isBotMember(memberById[userId]) || (!!fetchedId && fetchedId === userId);
}

// ---------------------------------------------------------------------------
// Visual language
// ---------------------------------------------------------------------------

const AI_CSS = `
@keyframes wk-ai-shimmer { 0% { background-position: 150% 0 } 100% { background-position: -150% 0 } }
.wk-ai-shimmer {
  background-image: linear-gradient(90deg, var(--muted) 0%, rgb(139 92 246 / 0.22) 45%, rgb(99 102 241 / 0.22) 55%, var(--muted) 100%);
  background-size: 250% 100%;
  animation: wk-ai-shimmer 1.6s ease-in-out infinite;
}
@keyframes wk-ai-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.wk-ai-in { animation: wk-ai-in 160ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .wk-ai-shimmer, .wk-ai-in { animation: none } }
`;

/** Shared keyframes for the AI UI (React 19 hoists and de-duplicates by href). */
export function AIStyles() {
  return (
    <style href="worklio-ai-composer" precedence="default">
      {AI_CSS}
    </style>
  );
}

/** The ✨ mark: a white sparkle on the violet→indigo gradient chip. */
export function AISparkle({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-linear-to-br from-violet-500 to-indigo-500 text-white shadow-sm shadow-violet-500/20",
        className,
      )}
    >
      <Sparkles className={cn("size-3", iconClassName)} />
    </span>
  );
}

/** "AI" / "APP" pill shown next to bot names. */
export function AIBadge({ label = "AI", className }: { label?: string; className?: string }) {
  return (
    <span
      title="Worklio AI — an assistant, not a person"
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-0.5 rounded-[4px] bg-linear-to-r from-violet-500/15 to-indigo-500/15 px-1 text-[10px] leading-none font-bold tracking-wide text-violet-700 ring-1 ring-violet-500/25 ring-inset dark:text-violet-300",
        className,
      )}
    >
      <Sparkles className="size-2.5" aria-hidden />
      {label}
    </span>
  );
}

const RING_RADIUS: Record<AvatarSize, string> = {
  xs: "rounded-[5px]",
  sm: "rounded-[6px]",
  md: "rounded-[8px]",
  lg: "rounded-[10px]",
  xl: "rounded-[10px]",
};

/** Avatar with a subtle gradient ring, for bot authors. */
export function BotAvatar({
  id,
  name,
  size = "md",
  className,
}: {
  id: string;
  name: string;
  size?: AvatarSize;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 bg-linear-to-br from-violet-500 via-fuchsia-500 to-indigo-500 p-[1.5px]",
        RING_RADIUS[size],
        className,
      )}
    >
      <span className={cn("inline-flex bg-background p-px", RING_RADIUS[size])}>
        <UserAvatar id={id} name={name} size={size} />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer rewrite (POST /ai/compose)
// ---------------------------------------------------------------------------

export type ComposeAction = "improve" | "shorter" | "longer" | "friendlier" | "formal" | "fix" | "bullets" | "translate";

export const COMPOSE_ACTIONS: { action: Exclude<ComposeAction, "translate">; label: string; icon: typeof Wand2 }[] = [
  { action: "improve", label: "Improve writing", icon: Wand2 },
  { action: "shorter", label: "Make shorter", icon: Minimize2 },
  { action: "longer", label: "Make longer", icon: Maximize2 },
  { action: "friendlier", label: "Friendlier", icon: HeartHandshake },
  { action: "formal", label: "More formal", icon: Briefcase },
  { action: "fix", label: "Fix spelling & grammar", icon: SpellCheck },
  { action: "bullets", label: "Turn into bullets", icon: List },
];

export const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Polish",
  "Turkish",
  "Russian",
  "Ukrainian",
  "Arabic",
  "Hebrew",
  "Hindi",
  "Urdu",
  "Bengali",
  "Indonesian",
  "Vietnamese",
  "Thai",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
];

export function actionLabel(action: ComposeAction, language?: string) {
  if (action === "translate") return `Translate to ${language ?? "…"}`;
  return COMPOSE_ACTIONS.find((a) => a.action === action)?.label ?? "Rewrite";
}

/** What gets rewritten: the selection if there is one, else the whole draft. */
export type ComposeSource = { text: string; start: number; end: number; whole: boolean };

type Base = { action: ComposeAction; language?: string; source: ComposeSource };
export type ComposeState =
  | (Base & { phase: "loading" })
  | (Base & { phase: "done"; result: string; encoded: string })
  | (Base & { phase: "error"; message: string });

function composeError(err: unknown): string {
  if (err instanceof AIError) {
    if (err.code === "rate_limited") return "You've hit the AI limit for now. Try again in a few minutes.";
    if (err.code === "refusal") return "Worklio AI can't help rewrite this one. Try different wording.";
    return err.message;
  }
  return errorMessage(err, "Worklio AI couldn't rewrite that. Try again.");
}

/**
 * State machine for one rewrite at a time. `encode`/`decode` convert between the composer's
 * "@Full Name" text and stored "<@id>" tokens so mentions survive the round-trip intact.
 */
export function useComposeAssistant({
  encode,
  decode,
}: {
  encode: (text: string) => string;
  decode: (text: string) => string;
}) {
  const { workspaceId } = useWorkspace();
  const [state, setState] = useState<ComposeState | null>(null);
  const seq = useRef(0);

  const run = (source: ComposeSource, action: ComposeAction, language?: string) => {
    if (!source.text.trim()) {
      toast.info("Write something first, then let Worklio AI polish it ✨");
      return;
    }
    const id = ++seq.current;
    setState({ phase: "loading", action, language, source });
    ai.compose({
      text: encode(source.text),
      action,
      ...(action === "translate" && language ? { target_language: language } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    })
      .then((r) => {
        if (id !== seq.current) return;
        const encoded = (r?.text ?? "").trim();
        if (!encoded) throw new Error("Worklio AI returned an empty rewrite. Try again.");
        setState({ phase: "done", action, language, source, encoded, result: decode(encoded) });
      })
      .catch((err) => {
        if (id !== seq.current) return;
        setState({ phase: "error", action, language, source, message: composeError(err) });
      });
  };

  const retry = () => {
    if (state) run(state.source, state.action, state.language);
  };

  const discard = () => {
    seq.current++;
    setState(null);
  };

  return { state, run, retry, discard };
}

/**
 * Where to apply a finished rewrite in the current draft. Uses the original range if the draft
 * is unchanged there, else the first occurrence of the source text, else null (append).
 */
export function locateSource(body: string, source: ComposeSource): { start: number; end: number } | null {
  if (body.slice(source.start, source.end) === source.text) return { start: source.start, end: source.end };
  const i = body.indexOf(source.text);
  return i >= 0 ? { start: i, end: i + source.text.length } : null;
}

/** Menu items for the composer's ✨ dropdown (render inside a DropdownMenuContent). */
export function AIComposeMenuItems({ onPick }: { onPick: (action: ComposeAction, language?: string) => void }) {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <AISparkle className="size-4 rounded" iconClassName="size-2.5" />
          <span className="bg-linear-to-r from-violet-600 to-indigo-600 bg-clip-text font-semibold text-transparent dark:from-violet-300 dark:to-indigo-300">
            Worklio AI
          </span>
          <span className="ml-auto text-[10px] font-normal">Rewrite draft or selection</span>
        </DropdownMenuLabel>
        {COMPOSE_ACTIONS.map((a) => (
          <DropdownMenuItem key={a.action} onClick={() => onPick(a.action)}>
            <a.icon className="size-4 text-violet-600 dark:text-violet-300" /> {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Languages className="size-4 text-violet-600 dark:text-violet-300" /> Translate to…
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-72 w-52">
          {LANGUAGES.map((lang) => (
            <DropdownMenuItem key={lang} onClick={() => onPick("translate", lang)}>
              {lang}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/** Inline preview card above the composer: shimmer while working, then the rewrite + actions. */
export function AIComposePreview({
  state,
  onReplace,
  onInsertBelow,
  onRetry,
  onDiscard,
}: {
  state: ComposeState;
  onReplace: () => void;
  onInsertBelow: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { memberById, me, workspaceId } = useWorkspace();
  const groups = useGroupsById(workspaceId);
  const label = actionLabel(state.action, state.language);

  return (
    <div
      role="region"
      aria-label="Worklio AI suggestion"
      aria-busy={state.phase === "loading" || undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDiscard();
        }
      }}
      className="wk-ai-in mb-2 overflow-hidden rounded-xl bg-linear-to-br from-violet-500/40 via-fuchsia-500/25 to-indigo-500/40 p-px shadow-sm shadow-violet-500/10"
    >
      <AIStyles />
      <div className="rounded-[11px] bg-background">
        <div className="flex items-center gap-2 border-b border-violet-500/10 bg-linear-to-r from-violet-500/[0.07] to-indigo-500/[0.07] px-3 py-1.5">
          <AISparkle />
          <span className="min-w-0 truncate text-xs font-bold">
            <span className="bg-linear-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent dark:from-violet-300 dark:to-indigo-300">
              Worklio AI
            </span>
            <span className="font-medium text-muted-foreground">
              {" "}
              · {label}
              {!state.source.whole && " · selection"}
            </span>
          </span>
          <button
            type="button"
            onClick={onDiscard}
            aria-label="Discard suggestion"
            title="Discard (Esc)"
            className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:size-6"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto px-3 py-2.5" aria-live="polite">
          {state.phase === "loading" ? (
            <div className="space-y-2 py-0.5" aria-label="Writing…">
              <div className="wk-ai-shimmer h-3 w-11/12 rounded-full" />
              <div className="wk-ai-shimmer h-3 w-4/5 rounded-full [animation-delay:120ms]" />
              <div className="wk-ai-shimmer h-3 w-3/5 rounded-full [animation-delay:240ms]" />
              <span className="sr-only">Worklio AI is writing…</span>
            </div>
          ) : state.phase === "error" ? (
            <p className="text-sm text-destructive">{state.message}</p>
          ) : (
            <div className="text-msg break-words whitespace-pre-wrap">
              {formatMessage(state.encoded, { names: memberById, meId: me?.id, groups })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
          {state.phase === "done" && (
            <>
              <button
                type="button"
                onClick={onReplace}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                title="Replace (⌘↵)"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-linear-to-r from-violet-600 to-indigo-600 px-2.5 text-xs font-bold text-white shadow-sm outline-none hover:from-violet-500 hover:to-indigo-500 focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 sm:h-7"
              >
                <Replace className="size-3.5" /> Replace
              </button>
              <PreviewButton onClick={onInsertBelow} icon={ArrowDownToLine}>
                Insert below
              </PreviewButton>
            </>
          )}
          {state.phase !== "loading" && (
            <PreviewButton onClick={onRetry} icon={RefreshCw}>
              Try again
            </PreviewButton>
          )}
          {state.phase === "loading" && (
            <span className="inline-flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground sm:h-7">
              <Loader2 className="size-3.5 animate-spin text-violet-500" aria-hidden /> Writing…
            </span>
          )}
          <PreviewButton onClick={onDiscard} icon={X}>
            Discard
          </PreviewButton>
          <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
            AI can make mistakes. Review before sending.
          </span>
        </div>
      </div>
    </div>
  );
}

function PreviewButton({
  onClick,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  icon: typeof X;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:h-7"
    >
      <Icon className="size-3.5" aria-hidden /> {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AI call summary card (system message, meta.type "call_ai_summary")
// ---------------------------------------------------------------------------

export type CallAIActionItem = { title: string; assignee_id?: string | null };
export type CallAISummaryMeta = {
  type: "call_ai_summary";
  call_id: string;
  action_items?: CallAIActionItem[];
  summary?: string;
  decisions?: string[];
};

export function isCallAISummaryMeta(meta: unknown): meta is CallAISummaryMeta {
  return !!meta && typeof meta === "object" && (meta as { type?: unknown }).type === "call_ai_summary";
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

function actionItemsOf(meta: CallAISummaryMeta): CallAIActionItem[] {
  if (!Array.isArray(meta.action_items)) return [];
  return meta.action_items
    .map((a): CallAIActionItem | null => {
      if (typeof a === "string") return { title: a };
      if (a && typeof a === "object" && typeof (a as CallAIActionItem).title === "string") {
        const assignee = (a as CallAIActionItem).assignee_id;
        return { title: (a as CallAIActionItem).title, assignee_id: typeof assignee === "string" ? assignee : null };
      }
      return null;
    })
    .filter((a): a is CallAIActionItem => !!a && !!a.title.trim());
}

/** Body without its "Action items" section (those render as interactive rows instead). */
function bodyWithoutActionItems(body: string): string {
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^\W*action items\b/i.test(l.trim()));
  return (i >= 0 ? lines.slice(0, i) : lines).join("\n").trim();
}

type ItemState = { later?: "busy" | "done"; board?: "busy" | "done" };

export function CallAISummaryCard({ message: m }: { message: Message }) {
  const { memberById, me, workspaceId } = useWorkspace();
  const groups = useGroupsById(workspaceId);
  const [items, setItems] = useState<Record<number, ItemState>>({});
  if (!isCallAISummaryMeta(m.meta)) return null;
  const meta = m.meta;
  const summary = typeof meta.summary === "string" ? meta.summary.trim() : "";
  const decisions = strings(meta.decisions);
  const actions = actionItemsOf(meta);
  const fallbackBody = summary ? "" : bodyWithoutActionItems(m.body ?? "");
  const fmt = (text: string) => formatMessage(text, { names: memberById, meId: me?.id, groups });

  const patch = (i: number, p: ItemState) => setItems((s) => ({ ...s, [i]: { ...s[i], ...p } }));

  const addToLater = async (i: number, a: CallAIActionItem) => {
    patch(i, { later: "busy" });
    try {
      await productivity.createLater(workspaceId, { title: a.title.slice(0, 300), notes: "From an AI call summary" });
      patch(i, { later: "done" });
      toast.success("Added to Later");
    } catch (err) {
      patch(i, { later: undefined });
      toast.error(`Couldn't add to Later: ${errorMessage(err)}`);
    }
  };

  const addToBoard = async (i: number, a: CallAIActionItem) => {
    patch(i, { board: "busy" });
    try {
      const board = await api<{ columns: { id: string; name: string; position: number }[] }>(
        `/channels/${m.channel_id}/board`,
      );
      const cols = [...(board?.columns ?? [])].sort((x, y) => x.position - y.position);
      const col = cols.find((c) => /to ?do|backlog/i.test(c.name)) ?? cols[0];
      if (!col) throw new Error("This board has no columns yet");
      await api(`/channels/${m.channel_id}/board/cards`, {
        method: "POST",
        body: JSON.stringify({
          column_id: col.id,
          title: a.title.slice(0, 300),
          description: "From an AI call summary",
          ...(a.assignee_id && memberById[a.assignee_id] ? { assignee_id: a.assignee_id } : {}),
        }),
      });
      patch(i, { board: "done" });
      toast.success(`Added to the board in “${col.name}”`);
    } catch (err) {
      patch(i, { board: undefined });
      toast.error(`Couldn't add to the board: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="mt-1 max-w-xl overflow-hidden rounded-xl bg-linear-to-br from-violet-500/35 via-fuchsia-500/20 to-indigo-500/35 p-px">
      <div className="rounded-[11px] bg-background">
        <div className="flex items-center gap-2 bg-linear-to-r from-violet-500/[0.08] to-indigo-500/[0.08] px-3 py-2">
          <AISparkle />
          <span className="text-sm font-bold">Call summary</span>
          <AIBadge />
        </div>

        <div className="space-y-3 px-3 py-2.5 text-sm">
          {(summary || fallbackBody) && (
            <div className="text-msg break-words whitespace-pre-wrap">{fmt(summary || fallbackBody)}</div>
          )}

          {decisions.length > 0 && (
            <section>
              <h4 className="mb-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Decisions</h4>
              <ul className="space-y-1">
                {decisions.map((d, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    <span className="min-w-0 break-words">{fmt(d)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {actions.length > 0 && (
            <section>
              <h4 className="mb-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Action items</h4>
              <ul className="divide-y rounded-lg border">
                {actions.map((a, i) => {
                  const st = items[i] ?? {};
                  const who = a.assignee_id ? memberById[a.assignee_id] : undefined;
                  return (
                    <li key={i} className="flex flex-col gap-1.5 px-2.5 py-2 sm:flex-row sm:items-center sm:gap-2">
                      <div className="flex min-w-0 flex-1 items-start gap-2">
                        <span className="mt-0.5 size-3.5 shrink-0 rounded-full border-2 border-violet-500/60" aria-hidden />
                        <div className="min-w-0">
                          <div className="break-words">{fmt(a.title)}</div>
                          {who && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                              <UserAvatar id={who.user_id} name={who.full_name} size="xs" />
                              {who.full_name}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1 pl-5.5 sm:pl-0">
                        <ItemButton
                          state={st.later}
                          onClick={() => addToLater(i, a)}
                          icon={st.later === "done" ? BookmarkCheck : Bookmark}
                          doneLabel="In Later"
                        >
                          Add to Later
                        </ItemButton>
                        <ItemButton
                          state={st.board}
                          onClick={() => addToBoard(i, a)}
                          icon={KanbanSquare}
                          doneLabel="On Board"
                        >
                          Add to Board
                        </ItemButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <Sparkles className="size-3 text-violet-500" aria-hidden />
          Generated by Worklio AI from the call transcript and notes · AI can make mistakes.
        </div>
      </div>
    </div>
  );
}

function ItemButton({
  state,
  onClick,
  icon: Icon,
  doneLabel,
  children,
}: {
  state?: "busy" | "done";
  onClick: () => void;
  icon: typeof Bookmark;
  doneLabel: string;
  children: React.ReactNode;
}) {
  const done = state === "done";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!state}
      aria-busy={state === "busy" || undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 sm:h-7",
        done
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "hover:border-violet-500/40 hover:bg-violet-500/[0.06] disabled:opacity-60",
      )}
    >
      {state === "busy" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : done ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Icon className="size-3.5" aria-hidden />
      )}
      {done ? doneLabel : children}
    </button>
  );
}
