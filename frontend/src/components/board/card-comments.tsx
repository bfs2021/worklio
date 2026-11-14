"use client";

import { Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { Button } from "@/components/ui/button";
import type { Member } from "@/lib/api";
import { decodeMentions, encodeMentions, formatMessage } from "@/lib/format";
import { listsApi, matchMembers, mentionQueryAt, newId } from "@/lib/lists";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { MAX_COMMENT_LENGTH, type BoardCard, type CardComment } from "./types";

const isTemp = (id: string) => id.startsWith("tmp-");

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Card comment thread with @mention autocomplete; live via `board.comments.updated`. */
export function CardComments({
  card,
  readOnly,
  onCountChange,
}: {
  card: BoardCard;
  readOnly: boolean;
  onCountChange: (delta: number) => void;
}) {
  const { me, members, memberById, isAdmin } = useWorkspace();
  const [comments, setComments] = useState<CardComment[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const scrollToEnd = useRef(false);
  const mounted = useRef(true);
  const seq = useRef(0);
  const cardId = card.id;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const mine = ++seq.current;
    listsApi
      .listComments(cardId)
      .then((list) => {
        if (mine !== seq.current || !mounted.current) return;
        setComments(list);
        setError("");
      })
      .catch((err) => {
        if (mine === seq.current && mounted.current) setError(errorMessage(err, "Couldn't load comments"));
      });
  }, [cardId, attempt]);

  useEffect(() => {
    if (!scrollToEnd.current) return;
    scrollToEnd.current = false;
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  /** Re-fetch quietly (realtime), keeping optimistic temp comments until the server catches up. */
  function refresh() {
    const mine = ++seq.current;
    listsApi
      .listComments(cardId)
      .then((list) => {
        if (mine !== seq.current || !mounted.current) return;
        setComments((prev) => [...list, ...(prev ?? []).filter((c) => isTemp(c.id))]);
      })
      .catch(() => {});
  }

  useWorkspaceEvents((e) => {
    const ev = e as unknown as { type: string; card_id?: string };
    if ((ev.type === "board.comments.updated" && ev.card_id === cardId) || ev.type === "resync") refresh();
  });

  function submit() {
    const text = draft.trim();
    if (!text || !me) return;
    const body = encodeMentions(text, members).slice(0, MAX_COMMENT_LENGTH);
    const temp: CardComment = { id: `tmp-${newId()}`, card_id: cardId, author_id: me.id, body, created_at: new Date().toISOString() };
    setComments((c) => [...(c ?? []), temp]);
    setDraft("");
    scrollToEnd.current = true;
    onCountChange(1);
    listsApi
      .addComment(cardId, body)
      .then((saved) => {
        if (!mounted.current) return;
        setComments((c) => (c ?? []).filter((x) => x.id !== saved.id).map((x) => (x.id === temp.id ? saved : x)));
      })
      .catch((err) => {
        if (!mounted.current) return;
        setComments((c) => (c ?? []).filter((x) => x.id !== temp.id));
        setDraft((d) => d || text);
        onCountChange(-1);
        toast.error(`Couldn't post comment: ${errorMessage(err)}`);
      });
  }

  function edit(comment: CardComment, text: string) {
    const body = encodeMentions(text.trim(), members).slice(0, MAX_COMMENT_LENGTH);
    if (!body || body === comment.body) return;
    const before = comment;
    setComments((c) => (c ?? []).map((x) => (x.id === comment.id ? { ...x, body, updated_at: new Date().toISOString(), edited_at: new Date().toISOString() } : x)));
    listsApi
      .updateComment(comment.id, body)
      .then((saved) => mounted.current && setComments((c) => (c ?? []).map((x) => (x.id === saved.id ? saved : x))))
      .catch((err) => {
        if (!mounted.current) return;
        setComments((c) => (c ?? []).map((x) => (x.id === before.id ? before : x)));
        toast.error(`Couldn't edit comment: ${errorMessage(err)}`);
      });
  }

  function remove(comment: CardComment) {
    const index = (comments ?? []).findIndex((x) => x.id === comment.id);
    setComments((c) => (c ?? []).filter((x) => x.id !== comment.id));
    onCountChange(-1);
    listsApi.deleteComment(comment.id).catch((err) => {
      if (!mounted.current) return;
      setComments((c) => {
        const list = [...(c ?? [])];
        list.splice(index < 0 ? list.length : index, 0, comment);
        return list;
      });
      onCountChange(1);
      toast.error(`Couldn't delete comment: ${errorMessage(err)}`);
    });
  }

  const count = comments?.length ?? card.comment_count;

  return (
    <section aria-labelledby={`comments-${cardId}`} className="grid gap-3">
      <h3 id={`comments-${cardId}`} className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        <MessageSquare className="size-3.5" aria-hidden /> Comments
        {count > 0 && <span className="font-semibold tabular-nums">{count}</span>}
      </h3>

      {comments === null && !error && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" aria-busy="true">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading comments…
        </div>
      )}
      {error && comments === null && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError("");
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {comments && comments.length === 0 && (
        <p className="text-sm text-muted-foreground">{readOnly ? "No comments." : "No comments yet. Start the discussion — @mention someone to loop them in."}</p>
      )}
      {comments && comments.length > 0 && (
        <ol ref={listRef} className="grid gap-3" aria-label="Comments">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              author={c.author_id ? memberById[c.author_id] : undefined}
              memberById={memberById}
              members={members}
              meId={me?.id}
              canEdit={!readOnly && !!me && c.author_id === me.id && !isTemp(c.id)}
              canDelete={!readOnly && !isTemp(c.id) && (!!me && (c.author_id === me.id || isAdmin))}
              onEdit={(text) => edit(c, text)}
              onDelete={() => remove(c)}
            />
          ))}
        </ol>
      )}

      {!readOnly && me && (
        <div className="flex items-start gap-2">
          <UserAvatar id={me.id} name={me.full_name} size="md" className="mt-0.5 max-sm:hidden" />
          <div className="min-w-0 flex-1">
            <MentionTextarea
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              members={members}
              placeholder="Write a comment… use @ to mention"
              ariaLabel="Write a comment"
            />
            <div className="mt-1.5 flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">Enter to send · Shift+Enter for a new line</span>
              <Button size="sm" className="ml-auto bg-send text-white hover:bg-send/90" disabled={!draft.trim()} onClick={submit}>
                Comment
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CommentItem({
  comment,
  author,
  memberById,
  members,
  meId,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  comment: CardComment;
  author: Member | undefined;
  memberById: Record<string, Member>;
  members: Member[];
  meId: string | undefined;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (text: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const edited =
    comment.edited_at !== undefined ? !!comment.edited_at : !!comment.updated_at && comment.updated_at !== comment.created_at;
  const name = author?.full_name ?? "Former member";

  return (
    <li className={cn("group/comment flex gap-2", isTemp(comment.id) && "opacity-60")}>
      <UserAvatar id={comment.author_id ?? "unknown"} name={name} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold">{name}</span>
          <time dateTime={comment.created_at} className="text-[11px] text-muted-foreground">
            {formatWhen(comment.created_at)}
          </time>
          {edited && <span className="text-[11px] text-muted-foreground">(edited)</span>}
          {(canEdit || canDelete) && editing === null && !confirming && (
            <span className="ml-auto flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/comment:opacity-100 sm:group-hover/comment:opacity-100">
              {canEdit && (
                <Button variant="ghost" size="icon-xs" aria-label="Edit comment" onClick={() => setEditing(decodeMentions(comment.body, memberById))}>
                  <Pencil />
                </Button>
              )}
              {canDelete && (
                <Button variant="ghost" size="icon-xs" aria-label="Delete comment" onClick={() => setConfirming(true)}>
                  <Trash2 />
                </Button>
              )}
            </span>
          )}
        </div>
        {editing !== null ? (
          <div className="mt-1">
            <MentionTextarea
              autoFocus
              value={editing}
              onChange={setEditing}
              members={members}
              ariaLabel="Edit comment"
              onSubmit={() => {
                onEdit(editing);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
            <div className="mt-1.5 flex gap-1.5">
              <Button
                size="sm"
                className="bg-send text-white hover:bg-send/90"
                disabled={!editing.trim()}
                onClick={() => {
                  onEdit(editing);
                  setEditing(null);
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{formatMessage(comment.body, { names: memberById, meId })}</div>
        )}
        {confirming && (
          <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="text-muted-foreground">Delete this comment?</span>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Delete
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Auto-growing textarea with an inline @mention listbox (arrows / Enter / Tab pick, Escape dismisses). */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  members,
  placeholder,
  ariaLabel,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  members: Member[];
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
}) {
  const [caret, setCaret] = useState(value.length);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const id = useId();

  const mention = mentionQueryAt(value, caret);
  const matches = mention && mention.start !== dismissedAt ? matchMembers(members, mention.query, 6) : [];
  const open = matches.length > 0;
  const activeIdx = open ? Math.min(active, matches.length - 1) : -1;

  useEffect(() => {
    const pos = pendingCaret.current;
    if (pos === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pos, pos);
  });

  function pick(m: Member) {
    if (!mention) return;
    const insert = `@${m.full_name} `;
    const next = value.slice(0, mention.start) + insert + value.slice(caret);
    const pos = mention.start + insert.length;
    onChange(next);
    setCaret(pos);
    setActive(0);
    pendingCaret.current = pos;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = matches.length;
        setActive((activeIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(mention?.start ?? null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (value.trim()) onSubmit();
      return;
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        rows={2}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-mentions` : undefined}
        aria-activedescendant={open ? `${id}-m-${activeIdx}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        className="field-sizing-content max-h-48 min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      {open && (
        <ul
          id={`${id}-mentions`}
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-64 max-w-full overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        >
          {matches.map((m, i) => (
            <li
              key={m.user_id}
              id={`${id}-m-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== activeIdx && setActive(i)}
              onClick={() => pick(m)}
              className={cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm", i === activeIdx && "bg-accent text-accent-foreground")}
            >
              <UserAvatar id={m.user_id} name={m.full_name} size="sm" />
              <span className="truncate">{m.full_name}</span>
              {m.title && <span className="ml-auto truncate text-xs text-muted-foreground">{m.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
