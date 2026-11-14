"use client";

import { Check, CornerDownRight, Ellipsis, Loader2, MessageSquare, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/components/workspace/provider";
import type { CanvasComment } from "@/lib/canvas";
import { decodeMentions, encodeMentions, formatMessage } from "@/lib/format";
import { cn } from "@/lib/utils";

import { timeAgo, useNow } from "./doc-utils";
import type { CommentThread, CommentsState } from "./use-comments";

export type CommentDraft = { anchorId: string; quote: string };

const BODY_MAX = 4000;

function Composer({
  placeholder,
  submitLabel,
  initial = "",
  autoFocus,
  onSubmit,
  onCancel,
  compact,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setText("");
    } catch {
      // The caller already toasted; keep the text so nothing is lost.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={cn("rounded-lg border bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30", compact && "text-[13px]")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={ref}
        value={text}
        maxLength={BODY_MAX}
        rows={1}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="block max-h-[200px] min-h-9 w-full resize-none bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
      />
      <div className="flex items-center justify-end gap-1.5 px-1.5 pb-1.5">
        {onCancel && (
          <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="xs" disabled={!text.trim() || busy} className="bg-send text-white hover:bg-send/90">
          {busy && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function CommentRow({
  comment,
  isRoot,
  thread,
  state,
  now,
}: {
  comment: CanvasComment;
  isRoot: boolean;
  thread: CommentThread;
  state: CommentsState;
  now: number;
}) {
  const { me, memberById, isAdmin } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const author = memberById[comment.author_id];
  const name = comment.author_id === me?.id ? (me?.full_name ?? "You") : (author?.full_name ?? "Former member");
  const mine = comment.author_id === me?.id;
  const pending = comment.id.startsWith("temp-");
  const canDelete = mine || isAdmin;

  return (
    <div className={cn("group/comment flex gap-2.5", pending && "opacity-60")}>
      <UserAvatar id={comment.author_id} name={name} size="md" className="mt-0.5 [&>span]:size-7" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-bold">{name}</span>
          <time
            dateTime={comment.created_at}
            title={new Date(comment.created_at).toLocaleString()}
            className="shrink-0 text-[11.5px] text-muted-foreground"
          >
            {pending ? "Sending…" : timeAgo(comment.created_at, now)}
          </time>
          {!pending && (mine || canDelete || isRoot) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Comment actions"
                    className="ml-auto opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/comment:opacity-100 aria-expanded:opacity-100"
                  />
                }
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {isRoot && (
                  <DropdownMenuItem onClick={() => void state.setResolved(thread.id, !thread.resolved).catch(() => {})}>
                    {thread.resolved ? <RotateCcw /> : <Check />}
                    {thread.resolved ? "Reopen thread" : "Resolve thread"}
                  </DropdownMenuItem>
                )}
                {mine && (
                  <DropdownMenuItem onClick={() => setEditing(true)}>
                    <Pencil /> Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => void state.remove(comment).catch(() => {})}>
                      <Trash2 /> {isRoot ? "Delete thread" : "Delete"}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {editing ? (
          <div className="mt-1">
            <Composer
              compact
              autoFocus
              initial={decodeMentions(comment.body, memberById)}
              placeholder="Edit comment"
              submitLabel="Save"
              onCancel={() => setEditing(false)}
              onSubmit={async (text) => {
                setEditing(false);
                await state.edit(comment.id, encodeMentions(text, Object.values(memberById)));
              }}
            />
          </div>
        ) : (
          <div className="mt-0.5 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
            {formatMessage(comment.body, { names: memberById, meId: me?.id })}
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  state,
  active,
  now,
  onActivate,
  onJump,
  readOnly,
}: {
  thread: CommentThread;
  state: CommentsState;
  active: boolean;
  now: number;
  onActivate: () => void;
  onJump: () => void;
  readOnly: boolean;
}) {
  const { members } = useWorkspace();
  const ref = useRef<HTMLElement>(null);
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <article
      ref={ref}
      aria-label="Comment thread"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button,a,textarea,input,[role=menuitem]")) return;
        onActivate();
      }}
      className={cn(
        "rounded-xl border bg-background p-3 transition-shadow",
        active ? "border-amber-400/70 shadow-md ring-2 ring-amber-300/40 dark:border-amber-400/40" : "hover:shadow-sm",
        thread.resolved && "bg-muted/40",
      )}
    >
      {thread.quote && (
        <button
          type="button"
          onClick={onJump}
          disabled={!thread.anchorId}
          title={thread.anchorId ? "Show in document" : undefined}
          className="mb-2.5 line-clamp-2 w-full border-l-[3px] border-amber-400/80 pl-2 text-left text-[12.5px] text-muted-foreground italic outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default"
        >
          {thread.quote}
        </button>
      )}
      <div className="space-y-3">
        <CommentRow comment={thread.root} isRoot thread={thread} state={state} now={now} />
        {thread.replies.map((r) => (
          <CommentRow key={r.id} comment={r} isRoot={false} thread={thread} state={state} now={now} />
        ))}
      </div>
      {thread.resolved ? (
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2.5">
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5" aria-hidden /> Resolved
          </span>
          {!readOnly && (
            <Button variant="ghost" size="xs" onClick={() => void state.setResolved(thread.id, false).catch(() => {})}>
              <RotateCcw /> Reopen
            </Button>
          )}
        </div>
      ) : readOnly ? null : replying || active ? (
        <div className="mt-3">
          <Composer
            compact
            autoFocus={replying}
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={replying ? () => setReplying(false) : undefined}
            onSubmit={(text) =>
              state.add({ body: encodeMentions(text, members), thread_id: thread.id }).then(() => setReplying(false))
            }
          />
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => setReplying(true)}>
            <CornerDownRight /> Reply
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => void state.setResolved(thread.id, true).catch(() => {})}
          >
            <Check /> Resolve
          </Button>
        </div>
      )}
    </article>
  );
}

export function CommentsPanel({
  state,
  draft,
  activeThreadId,
  onActivate,
  onJump,
  onSubmitDraft,
  onCancelDraft,
  onClose,
  readOnly,
  className,
}: {
  state: CommentsState;
  draft: CommentDraft | null;
  activeThreadId: string | null;
  onActivate: (threadId: string | null) => void;
  onJump: (thread: CommentThread) => void;
  onSubmitDraft: (text: string) => Promise<unknown>;
  onCancelDraft: () => void;
  onClose: () => void;
  readOnly: boolean;
  className?: string;
}) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const now = useNow(30_000);
  const open = state.threads.filter((t) => !t.resolved);
  const resolved = state.threads.filter((t) => t.resolved);
  const activeIsResolved = !!activeThreadId && resolved.some((t) => t.id === activeThreadId);
  // Jumping to a resolved thread from the document shows the resolved tab.
  const shownFilter = activeIsResolved ? "resolved" : filter;
  const shown = (shownFilter === "open" ? open : resolved).sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  return (
    <aside aria-label="Comments" className={cn("flex min-h-0 flex-col bg-muted/20", className)}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-bold">Comments</h2>
        <div role="tablist" aria-label="Filter comments" className="ml-auto flex rounded-lg bg-muted p-0.5 text-xs font-semibold">
          {(["open", "resolved"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={shownFilter === k}
              onClick={() => {
                setFilter(k);
                if (activeIsResolved && k === "open") onActivate(null);
              }}
              className={cn(
                "rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                shownFilter === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "open" ? "Open" : "Resolved"} {(k === "open" ? open : resolved).length || ""}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {draft && (
          <div className="rounded-xl border border-amber-400/70 bg-background p-3 shadow-md ring-2 ring-amber-300/40 dark:border-amber-400/40">
            <p className="mb-2 line-clamp-3 border-l-[3px] border-amber-400/80 pl-2 text-[12.5px] text-muted-foreground italic">
              {draft.quote}
            </p>
            <Composer
              key={draft.anchorId}
              autoFocus
              placeholder="Add a comment…"
              submitLabel="Comment"
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          </div>
        )}

        {state.status === "loading" ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading comments">
            {[0, 1].map((i) => (
              <div key={i} className="animate-pulse rounded-xl border bg-background p-3">
                <div className="mb-3 h-3 w-3/4 rounded bg-muted" />
                <div className="flex gap-2.5">
                  <div className="size-7 rounded-md bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 rounded bg-muted" />
                    <div className="h-3 rounded bg-muted" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : state.status === "error" ? (
          <div role="alert" className="px-2 py-8 text-center">
            <p className="text-sm font-bold">Couldn&apos;t load comments</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{state.error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={state.retry}>
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : shown.length === 0 && !draft ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-mention text-mention-foreground">
              <MessageSquare className="size-5" aria-hidden />
            </div>
            <p className="text-sm font-bold">{shownFilter === "open" ? "No open comments" : "No resolved comments"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {shownFilter === "open" && !readOnly
                ? "Select some text in the canvas and choose Comment to start a discussion."
                : "Resolved threads show up here."}
            </p>
          </div>
        ) : (
          shown.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              state={state}
              now={now}
              active={t.id === activeThreadId}
              onActivate={() => onActivate(t.id)}
              onJump={() => onJump(t)}
              readOnly={readOnly}
            />
          ))
        )}
      </div>
    </aside>
  );
}
