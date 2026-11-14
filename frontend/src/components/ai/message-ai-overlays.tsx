"use client";

import { CalendarDays, Check, KanbanSquare, ListTodo, Loader2, MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { Board } from "@/components/board/types";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { threadPath } from "@/components/views/message-snippet";
import { useWorkspace } from "@/components/workspace/provider";
import { ai, aiErrorCode, aiErrorMessage, aiPaths, useAIGate, type AIGateReason, type ExtractedTask } from "@/lib/ai";
import { api, type Message } from "@/lib/api";
import { decodeMentions } from "@/lib/format";
import { productivity } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { closeCreateTasks, closeThreadSummary, useAIUI } from "./ai-store";
import { AIDisabledState, AIDisclaimer, AIErrorNote, AILabel, AISparkle, AIThinking, AI_SURFACE, gateFromError } from "./brand";
import { TranslateDialog } from "./message-translation";
import { ActionButton, StreamedAnswer } from "./streamed-answer";

/**
 * Hosts the AI overlays opened from message actions (thread summary, create tasks, translate
 * fallback). Rendered by <AskWorklioPanel/>, so mounting that once per workspace is enough.
 */
export function MessageAIOverlays() {
  const thread = useAIUI((s) => s.threadSummary);
  const tasks = useAIUI((s) => s.tasks);
  const translate = useAIUI((s) => s.translateDialog);
  return (
    <>
      {thread && <ThreadSummarySheet key={thread.nonce} message={thread.message} />}
      {tasks && <CreateTasksDialog key={tasks.nonce} message={tasks.message} />}
      {translate && <TranslateDialog key={translate.id} message={translate} />}
    </>
  );
}

const rootOf = (m: Message) => m.parent_id ?? m.id;

function preview(m: Message, names: Parameters<typeof decodeMentions>[1]) {
  const t = decodeMentions(m.body, names).replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t || "(attachment)";
}

// --- Thread summary ---

function ThreadSummarySheet({ message }: { message: Message }) {
  const ws = useWorkspace();
  const router = useRouter();
  const channel = ws.channels.find((c) => c.id === message.channel_id);
  const label = channel ? (channel.kind === "dm" ? ws.channelLabel(channel) : `#${ws.channelLabel(channel)}`) : "";
  const author = ws.memberById[message.author_id]?.full_name ?? "Someone";
  const rootId = rootOf(message);
  const gate = useAIGate("summaries");
  return (
    <Sheet open onOpenChange={(o) => !o && closeThreadSummary()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className={cn("border-b pr-12", AI_SURFACE)}>
          <SheetTitle className="flex items-center gap-2">
            <AILabel>Thread summary</AILabel>
          </SheetTitle>
          <SheetDescription className="truncate">
            {label ? `In ${label} · ` : ""}started by {author}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {!message.parent_id && (
            <blockquote className="border-l-2 border-border pl-3 text-[13px] text-muted-foreground">
              {preview(message, ws.memberById)}
            </blockquote>
          )}
          {gate.reason ? (
            <AIDisabledState feature="summaries" onNavigate={closeThreadSummary} />
          ) : (
          <StreamedAnswer
            path={aiPaths.threadSummary(rootId)}
            body={{}}
            feature="summaries"
            thinking="Reading the thread…"
            empty="This thread doesn't have enough to summarize yet."
            onJump={closeThreadSummary}
            actions={() => (
              <ActionButton
                onClick={() => {
                  closeThreadSummary();
                  router.push(threadPath({ id: rootId, workspace_id: ws.workspaceId, channel_id: message.channel_id }));
                }}
              >
                <MessageSquareText className="size-3.5" /> Open thread
              </ActionButton>
            )}
          />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// --- Create tasks ---

type Draft = ExtractedTask & { key: number; selected: boolean };
type Destination = "later" | "board";

const dueLabel = (d: string) => {
  const date = new Date(`${d}T00:00:00`);
  return Number.isNaN(date.getTime()) ? d : date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};

function CreateTasksDialog({ message }: { message: Message }) {
  const ws = useWorkspace();
  const rootId = rootOf(message);
  const channel = ws.channels.find((c) => c.id === message.channel_id);
  const canBoard = !!channel && channel.kind !== "dm" && !channel.is_archived;
  const label = channel ? ws.channelLabel(channel) : "";

  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const gate = useAIGate("tasks");
  const blocked = !!gate.reason;
  const [error, setError] = useState<{ message: string; gate: AIGateReason | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dest, setDest] = useState<Destination>("later");
  const [board, setBoard] = useState<Board | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [columnId, setColumnId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (blocked) return;
    let live = true;
    ai.tasks(rootId)
      .then((tasks) => {
        if (!live) return;
        setError(null);
        setDrafts(tasks.map((t, i) => ({ ...t, key: i, selected: true })));
      })
      .catch((err) => {
        if (!live) return;
        setError({ message: aiErrorMessage(err), gate: gateFromError(aiErrorCode(err)) });
      });
    return () => {
      live = false;
    };
  }, [rootId, attempt, blocked]);

  const pickBoard = () => {
    setDest("board");
    if (board || !channel) return;
    setBoardError(null);
    api<Board>(`/channels/${channel.id}/board`)
      .then((b) => {
        const cols = [...b.columns].sort((a, z) => a.position - z.position);
        setBoard({ ...b, columns: cols });
        const first = cols.find((c) => !/done|complete/i.test(c.name)) ?? cols[0];
        setColumnId(first?.id ?? "");
      })
      .catch((err) => setBoardError(`Couldn't load the board: ${errorMessage(err)}`));
  };

  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((list) => list?.map((d) => (d.key === key ? { ...d, ...patch } : d)) ?? list);

  const chosen = drafts?.filter((d) => d.selected && d.title.trim()) ?? [];

  const save = async () => {
    if (!chosen.length) return;
    if (dest === "board" && (!channel || !columnId)) return;
    setSaving(true);
    let ok = 0;
    const failed: string[] = [];
    for (const t of chosen) {
      try {
        if (dest === "later") {
          await productivity.createLater(ws.workspaceId, {
            title: t.title.trim(),
            notes: `From a thread in ${channel ? (channel.kind === "dm" ? label : `#${label}`) : "Worklio"} (created with Worklio AI)`,
            due_at: t.due_date ? new Date(`${t.due_date}T09:00:00`).toISOString() : null,
          });
        } else {
          await api(`/channels/${channel!.id}/board/cards`, {
            method: "POST",
            body: JSON.stringify({
              column_id: columnId,
              title: t.title.trim(),
              assignee_id: t.assignee_id,
              due_date: t.due_date,
              description: "Created with Worklio AI from a thread.",
            }),
          });
        }
        ok++;
      } catch (err) {
        failed.push(`${t.title}: ${errorMessage(err)}`);
      }
    }
    setSaving(false);
    if (ok) {
      const where = dest === "later" ? "Later" : `the #${label} board`;
      toast.success(`Added ${ok} ${ok === 1 ? "task" : "tasks"} to ${where}`);
    }
    if (failed.length) toast.error(`Couldn't add ${failed.length} ${failed.length === 1 ? "task" : "tasks"}. ${failed[0]}`);
    else closeCreateTasks();
  };

  const members = ws.members.filter((m) => m.role !== "guest" || channel?.member_ids.includes(m.user_id));

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && closeCreateTasks()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AISparkle /> Create tasks from this thread
          </DialogTitle>
          <DialogDescription>
            Worklio AI pulled out the action items. Review them, then add them to your Later list or the channel board.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] min-h-24 overflow-y-auto">
          {blocked ? (
            <AIDisabledState compact feature="tasks" onNavigate={closeCreateTasks} />
          ) : error ? (
            error.gate ? (
              <AIDisabledState compact feature="tasks" reason={error.gate} onNavigate={closeCreateTasks} />
            ) : (
              <AIErrorNote
                message={error.message}
                onRetry={() => {
                  setError(null);
                  setDrafts(null);
                  setAttempt((n) => n + 1);
                }}
              />
            )
          ) : !drafts ? (
            <div className="py-3">
              <AIThinking text="Finding action items…" />
            </div>
          ) : drafts.length === 0 ? (
            <div className={cn("rounded-lg p-4 text-center text-sm text-muted-foreground", AI_SURFACE)}>
              No action items found in this thread.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {drafts.map((d) => {
                const assignee = d.assignee_id ? ws.memberById[d.assignee_id] : undefined;
                return (
                  <li
                    key={d.key}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                      d.selected ? "border-violet-500/30 bg-violet-500/[0.04]" : "opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={d.selected}
                      onChange={(e) => update(d.key, { selected: e.target.checked })}
                      aria-label={`Include "${d.title}"`}
                      className="mt-1.5 size-4 shrink-0 accent-violet-600"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <input
                        value={d.title}
                        onChange={(e) => update(d.key, { title: e.target.value })}
                        aria-label="Task title"
                        className="w-full rounded-md bg-transparent px-1 py-0.5 text-sm font-semibold outline-none focus:bg-background focus:ring-2 focus:ring-violet-500/40"
                      />
                      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
                        <label className="inline-flex items-center gap-1">
                          {assignee ? (
                            <UserAvatar id={assignee.user_id} name={assignee.full_name} size="sm" className="size-4" />
                          ) : null}
                          <select
                            value={d.assignee_id ?? ""}
                            onChange={(e) => update(d.key, { assignee_id: e.target.value || null })}
                            aria-label="Assignee"
                            className="max-w-40 rounded bg-transparent py-0.5 hover:bg-muted focus:outline-none"
                          >
                            <option value="">Unassigned</option>
                            {members.map((m) => (
                              <option key={m.user_id} value={m.user_id}>
                                {m.full_name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="inline-flex items-center gap-1">
                          <CalendarDays className="size-3.5" />
                          <input
                            type="date"
                            value={d.due_date ?? ""}
                            onChange={(e) => update(d.key, { due_date: e.target.value || null })}
                            aria-label="Due date"
                            title={d.due_date ? dueLabel(d.due_date) : "No due date"}
                            className="rounded bg-transparent py-0.5 hover:bg-muted focus:outline-none [&::-webkit-calendar-picker-indicator]:opacity-60"
                          />
                        </label>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {drafts && drafts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-muted-foreground">Add to</p>
            <div role="radiogroup" aria-label="Destination" className="grid gap-2 sm:grid-cols-2">
              <DestinationOption active={dest === "later"} onClick={() => setDest("later")} icon={ListTodo} title="Later" hint="As to-dos in your Later list" />
              <DestinationOption
                active={dest === "board"}
                onClick={pickBoard}
                icon={KanbanSquare}
                title={canBoard ? `#${label} board` : "Channel board"}
                hint={canBoard ? "As cards everyone in the channel can see" : "Only available in channels"}
                disabled={!canBoard}
              />
            </div>
            {dest === "board" && (
              <div className="flex items-center gap-2 text-sm">
                {boardError ? (
                  <span className="text-xs text-destructive">{boardError}</span>
                ) : !board ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading board…
                  </span>
                ) : board.columns.length === 0 ? (
                  <span className="text-xs text-muted-foreground">This board has no columns yet. Add one from the Board tab.</span>
                ) : (
                  <label className="inline-flex items-center gap-2 text-xs">
                    <span className="font-semibold text-muted-foreground">Column</span>
                    <select
                      value={columnId}
                      onChange={(e) => setColumnId(e.target.value)}
                      className="h-8 rounded-lg border bg-background px-2 text-sm"
                    >
                      {board.columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <AIDisclaimer className="hidden sm:flex" />
          <div className="flex gap-2">
            <ActionButton onClick={closeCreateTasks} disabled={saving}>
              Cancel
            </ActionButton>
            <ActionButton
              primary
              onClick={save}
              disabled={saving || !chosen.length || (dest === "board" && (!board || !columnId))}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"}` : "Add tasks"}
            </ActionButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationOption({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "border-violet-500/60 bg-violet-500/[0.06] ring-1 ring-violet-500/30" : "hover:bg-muted",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-violet-600 dark:text-violet-300" : "text-muted-foreground")} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
