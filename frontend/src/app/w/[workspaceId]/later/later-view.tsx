"use client";

import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Bookmark,
  CalendarClock,
  Check,
  ExternalLink,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useNow } from "@/components/profile/profile-utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChannelTag, MessageSnippet } from "@/components/views/message-snippet";
import { TimePicker } from "@/components/views/time-picker";
import { usePaged } from "@/components/views/use-paged";
import { SELECTED_ROW, useListNav } from "@/components/views/use-list-nav";
import { EmptyState, ErrorBlock, KeyHint, LoadingList, ViewHeader, ViewPage, ViewTabs } from "@/components/views/view-shell";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { messagePath } from "@/lib/messages";
import {
  asProductivityEvent,
  notifyLaterChanged,
  productivity,
  useLaterCount,
  whenLabel,
  type SavedItem,
  type SavedPatch,
  type SavedStatus,
} from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const TABS: { key: SavedStatus; label: string }[] = [
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "archived", label: "Archived" },
];

const time = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY);

/** In progress: overdue/soonest due first, then newest. Others: most recent first. */
function sortItems(list: SavedItem[], status: SavedStatus): SavedItem[] {
  return [...list].sort((a, b) => {
    if (status === "in_progress") {
      const d = time(a.due_at) - time(b.due_at);
      if (d && Number.isFinite(d)) return d;
      if (a.due_at && !b.due_at) return -1;
      if (!a.due_at && b.due_at) return 1;
    }
    const ka = status === "completed" ? (a.completed_at ?? a.created_at) : a.created_at;
    const kb = status === "completed" ? (b.completed_at ?? b.created_at) : b.created_at;
    return kb.localeCompare(ka);
  });
}

export function LaterView() {
  const ws = useWorkspace();
  const router = useRouter();
  const now = useNow();
  const [tab, setTab] = useState<SavedStatus>("in_progress");
  const [editingId, setEditingId] = useState<string | null>(null);
  const liveCount = useLaterCount(ws.workspaceId);

  const paged = usePaged(
    `${ws.workspaceId}:${tab}`,
    () => productivity.later(ws.workspaceId, tab).then((items) => ({ items, next_cursor: null })),
    (s: SavedItem) => s.id,
  );
  const { setItems } = paged;
  const items = paged.items ? sortItems(paged.items, tab) : null;
  const overdue = now && tab === "in_progress" ? (items ?? []).filter((s) => s.due_at && time(s.due_at) < now).length : 0;

  /** Optimistic PATCH; the item leaves the list when its status moves to another tab. */
  const patch = (item: SavedItem, change: SavedPatch, done?: string) => {
    const optimistic: SavedItem = {
      ...item,
      ...change,
      completed_at: change.status === "completed" ? new Date().toISOString() : change.status ? null : item.completed_at,
    };
    const leaves = !!change.status && change.status !== tab;
    // Sidebar badge: moving into / out of "In progress" changes the count right away.
    const delta =
      change.status && change.status !== item.status
        ? change.status === "in_progress"
          ? 1
          : item.status === "in_progress"
            ? -1
            : 0
        : 0;
    if (delta) notifyLaterChanged({ workspaceId: ws.workspaceId, delta, refetch: false });
    setItems((list) => (leaves ? list.filter((s) => s.id !== item.id) : list.map((s) => (s.id === item.id ? optimistic : s))));
    productivity
      .updateLater(item.id, change)
      .then((saved) => {
        if (!leaves) setItems((list) => list.map((s) => (s.id === item.id ? saved : s)));
        if (done) toast.success(done);
      })
      .catch((err) => {
        if (delta) notifyLaterChanged({ workspaceId: ws.workspaceId, delta: -delta });
        setItems((list) => (list.some((s) => s.id === item.id) ? list.map((s) => (s.id === item.id ? item : s)) : [...list, item]));
        toast.error(`Couldn't update: ${errorMessage(err)}`);
      });
  };

  const remove = (item: SavedItem) => {
    const delta = item.status === "in_progress" ? -1 : 0;
    if (delta) notifyLaterChanged({ workspaceId: ws.workspaceId, delta, refetch: false });
    setItems((list) => list.filter((s) => s.id !== item.id));
    productivity
      .deleteLater(item.id)
      .then(() => toast.success(item.kind === "todo" ? "To-do deleted" : "Removed from Later"))
      .catch((err) => {
        if (delta) notifyLaterChanged({ workspaceId: ws.workspaceId, delta: -delta });
        setItems((list) => (list.some((s) => s.id === item.id) ? list : [...list, item]));
        toast.error(`Couldn't delete: ${errorMessage(err)}`);
      });
  };

  const add = (draft: { title: string; due_at: string | null; remind_at: string | null }) => {
    const tempId = `temp-${Math.random().toString(36).slice(2)}`;
    const temp: SavedItem = {
      id: tempId,
      workspace_id: ws.workspaceId,
      kind: "todo",
      message: null,
      title: draft.title,
      notes: null,
      status: "in_progress",
      due_at: draft.due_at,
      remind_at: draft.remind_at,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    setItems((list) => [temp, ...list]);
    notifyLaterChanged({ workspaceId: ws.workspaceId, delta: 1, refetch: false });
    return productivity
      .createLater(ws.workspaceId, { title: draft.title, due_at: draft.due_at, remind_at: draft.remind_at })
      .then((saved) =>
        // The realtime echo may have inserted the saved item already: keep a single copy.
        setItems((list) => list.filter((s) => s.id !== saved.id).map((s) => (s.id === tempId ? saved : s))),
      )
      .catch((err) => {
        notifyLaterChanged({ workspaceId: ws.workspaceId, delta: -1 });
        setItems((list) => list.filter((s) => s.id !== tempId));
        toast.error(`Couldn't add to-do: ${errorMessage(err)}`);
        throw err;
      });
  };

  const openItem = (s: SavedItem) => {
    if (s.message) router.push(messagePath(s.message), { scroll: false });
    else setEditingId(s.id);
  };

  const nav = useListNav({
    scope: "later",
    count: items?.length ?? 0,
    onOpen: (i) => items?.[i] && openItem(items[i]),
  });

  useWorkspaceEvents((e) => {
    const p = asProductivityEvent(e);
    if (p?.type === "reminder.due") {
      // The workspace provider shows the toast / desktop notification; just refresh the list.
      paged.reload(true);
      return;
    }
    if (e.type === "resync") return paged.reload(true);
    // Saved / changed from anywhere else (a message's bookmark action, another tab or device).
    const t = (e as { type: string }).type;
    if (t === "later.updated") {
      const item = (e as unknown as { item?: SavedItem }).item;
      if (!item || item.workspace_id !== ws.workspaceId) return;
      setItems((list) => {
        const has = list.some((s) => s.id === item.id);
        if (item.status !== tab) return has ? list.filter((s) => s.id !== item.id) : list;
        if (has) return list.map((s) => (s.id === item.id ? item : s));
        // Our own optimistic to-do is still pending: let its POST response swap it in instead.
        if (list.some((s) => s.id.startsWith("temp-") && s.kind === item.kind && s.title === item.title)) return list;
        return [item, ...list];
      });
      return;
    }
    if (t === "later.deleted") {
      const { id } = e as unknown as { id?: string };
      if (id) setItems((list) => list.filter((s) => s.id !== id));
      return;
    }
    if (e.type === "message.deleted") {
      setItems((list) =>
        list.some((s) => s.message?.id === e.message_id)
          ? list.map((s) => (s.message?.id === e.message_id ? { ...s, message: null } : s))
          : list,
      );
      return;
    }
    if (e.type === "message.updated") {
      setItems((list) =>
        list.some((s) => s.message?.id === e.message.id)
          ? list.map((s) => (s.message?.id === e.message.id ? { ...s, message: { ...s.message, ...e.message } } : s))
          : list,
      );
    }
  });

  return (
    <ViewPage label="Later">
      <ViewHeader
        icon={Bookmark}
        title="Later"
        subtitle={overdue ? <span className="font-semibold text-destructive">{overdue} overdue</span> : "Saved messages, to-dos and reminders"}
        actions={
          overdue ? (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-bold text-destructive sm:hidden">{overdue} overdue</span>
          ) : undefined
        }
      >
        <ViewTabs
          label="Later status"
          tabs={TABS.map((t) => ({
            ...t,
            // In progress always shows its live count (the same number as the sidebar badge).
            count: t.key !== "in_progress" ? undefined : tab === "in_progress" && items ? items.length : (liveCount ?? undefined),
          }))}
          value={tab}
          onChange={(k) => {
            setEditingId(null);
            setTab(k);
          }}
          trailing={<KeyHint />}
        />
      </ViewHeader>

      <div className="flex-1 overflow-y-auto">
        {tab === "in_progress" && <AddTodo onAdd={add} />}
        {paged.error && <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />}
        {!items && !paged.error && <LoadingList />}
        {items?.length === 0 && (
          <EmptyState
            icon={tab === "in_progress" ? ListChecks : tab === "completed" ? Check : Archive}
            title={tab === "in_progress" ? "Nothing saved for later" : tab === "completed" ? "Nothing completed yet" : "Nothing archived"}
          >
            {tab === "in_progress"
              ? "Save messages from any conversation with the bookmark action, or add a to-do above. Add a due date or reminder and Worklio will nudge you."
              : tab === "completed"
                ? "Check off items in progress and they'll land here."
                : "Archived items are kept here, out of your way."}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <ul role="list">
            {items.map((s, i) => (
              <li key={s.id}>
                <LaterRow
                  item={s}
                  now={now}
                  editing={editingId === s.id}
                  onEdit={(on) => setEditingId(on ? s.id : null)}
                  navProps={nav.rowProps(i)}
                  onSelect={() => nav.setIndex(i)}
                  onPatch={(change, done) => patch(s, change, done)}
                  onDelete={() => remove(s)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ViewPage>
  );
}

function AddTodo({ onAdd }: { onAdd: (d: { title: string; due_at: string | null; remind_at: string | null }) => Promise<void> }) {
  const now = useNow();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [remind, setRemind] = useState<string | null>(null);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const draft = { title: t.slice(0, 500), due_at: due, remind_at: remind };
    setTitle("");
    setDue(null);
    setRemind(null);
    onAdd(draft).catch(() => {
      // Give the text back so nothing typed is lost.
      setTitle((cur) => cur || draft.title);
      setDue((d) => d ?? draft.due_at);
      setRemind((r) => r ?? draft.remind_at);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5 sm:flex-nowrap sm:px-5"
    >
      <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a to-do…"
        aria-label="New to-do"
        maxLength={500}
        className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex shrink-0 items-center gap-1">
        <TimePicker title="Due" value={due} onChange={setDue} triggerLabel="Set due date" triggerClassName={pickerBtn(!!due)}>
          <CalendarClock className="size-3.5" />
          <span className="max-w-36 truncate">{due ? whenLabel(due, now) : "Due"}</span>
        </TimePicker>
        <TimePicker title="Remind me" value={remind} onChange={setRemind} triggerLabel="Set reminder" triggerClassName={pickerBtn(!!remind)}>
          <AlarmClock className="size-3.5" />
          <span className="max-w-36 truncate">{remind ? whenLabel(remind, now) : "Remind"}</span>
        </TimePicker>
        <Button type="submit" size="sm" disabled={!title.trim()} className="bg-send text-white hover:bg-send/90">
          Add
        </Button>
      </div>
    </form>
  );
}

const pickerBtn = (set: boolean) =>
  cn(
    "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-semibold hover:bg-muted",
    set ? "border-tab/40 text-foreground" : "text-muted-foreground",
  );

function LaterRow({
  item: s,
  now,
  editing,
  onEdit,
  navProps,
  onSelect,
  onPatch,
  onDelete,
}: {
  item: SavedItem;
  now: number;
  editing: boolean;
  onEdit: (on: boolean) => void;
  navProps: Record<string, unknown>;
  onSelect: () => void;
  onPatch: (change: SavedPatch, done?: string) => void;
  onDelete: () => void;
}) {
  const pending = s.id.startsWith("temp-");
  const done = s.status === "completed";
  const dueMs = s.due_at ? new Date(s.due_at).getTime() : null;
  const overdue = !!now && dueMs !== null && dueMs < now && s.status === "in_progress";
  const dueSoon = !!now && dueMs !== null && !overdue && dueMs - now < 24 * 3_600_000 && s.status === "in_progress";
  const remindPending = !!s.remind_at && (!now || new Date(s.remind_at).getTime() > now);

  return (
    <div
      {...navProps}
      onFocusCapture={onSelect}
      className={cn(
        "group flex gap-3 border-b px-4 py-3 hover:bg-muted/40 sm:px-5",
        SELECTED_ROW,
        overdue && "shadow-[inset_2px_0_0_var(--destructive)]",
        pending && "opacity-60",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        disabled={pending || s.status === "archived"}
        onClick={() =>
          onPatch(done ? { status: "in_progress" } : { status: "completed" }, done ? "Moved back to In progress" : "Marked complete")
        }
        aria-label={done ? "Mark as not done" : "Mark as done"}
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40",
          done ? "border-send bg-send text-white" : "border-muted-foreground/40 hover:border-send hover:bg-send/10",
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </button>

      <div className="min-w-0 flex-1">
        {editing ? (
          <EditForm item={s} onCancel={() => onEdit(false)} onSave={(c) => {
              onPatch(c);
              onEdit(false);
            }} />
        ) : s.kind === "todo" ? (
          <button type="button" onClick={() => onEdit(true)} className="block w-full text-left" disabled={pending}>
            <span className={cn("text-[15px] font-semibold break-words", done && "text-muted-foreground line-through")}>
              {s.title}
            </span>
            {s.notes && <span className="mt-0.5 block text-sm whitespace-pre-wrap text-muted-foreground">{s.notes}</span>}
          </button>
        ) : s.message ? (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <ChannelTag channelId={s.message.channel_id} link />
              {s.message.parent_id && <span>· thread reply</span>}
            </div>
            <Link href={messagePath(s.message)} scroll={false} className={cn("block rounded-md", done && "opacity-70")}>
              <MessageSnippet message={s.message} clamp={4} />
            </Link>
            {s.notes && <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{s.notes}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">This message is no longer available.</p>
        )}

        {(s.due_at || s.remind_at || s.completed_at) && !editing && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            {s.due_at && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
                  overdue
                    ? "bg-destructive/10 text-destructive"
                    : dueSoon
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "bg-muted text-muted-foreground",
                )}
              >
                <CalendarClock className="size-3" />
                {overdue ? "Overdue · " : "Due "}
                {whenLabel(s.due_at, now)}
              </span>
            )}
            {s.remind_at && s.status === "in_progress" && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
                  remindPending ? "bg-mention text-mention-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                <AlarmClock className="size-3" />
                {remindPending ? "Reminder " : "Reminded "}
                {whenLabel(s.remind_at, now)}
              </span>
            )}
            {done && s.completed_at && <span className="text-muted-foreground">Completed {whenLabel(s.completed_at, now)}</span>}
          </div>
        )}
      </div>

      {!pending && !editing && (
        <div className="flex shrink-0 items-start gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 md:group-data-[selected]:opacity-100">
          {s.status === "in_progress" && (
            <>
              <TimePicker
                title="Due"
                value={s.due_at}
                onChange={(v) => onPatch({ due_at: v }, v ? "Due date set" : "Due date cleared")}
                triggerLabel="Set due date"
                triggerClassName={iconBtn}
              >
                <CalendarClock className="size-4" />
              </TimePicker>
              <TimePicker
                title="Remind me"
                value={s.remind_at}
                onChange={(v) => onPatch({ remind_at: v }, v ? `Reminder set for ${whenLabel(v, Date.now())}` : "Reminder removed")}
                triggerLabel="Set reminder"
                triggerClassName={iconBtn}
              >
                <AlarmClock className="size-4" />
              </TimePicker>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className={iconBtn} aria-label="More actions">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {s.message && (
                <DropdownMenuItem render={<Link href={messagePath(s.message)} scroll={false} />}>
                  <ExternalLink /> Open message
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onEdit(true)}>
                <Pencil /> {s.kind === "todo" ? "Edit" : "Edit note"}
              </DropdownMenuItem>
              {s.status === "archived" ? (
                <DropdownMenuItem onClick={() => onPatch({ status: "in_progress" }, "Moved to In progress")}>
                  <ArchiveRestore /> Move to In progress
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onPatch({ status: "archived" }, "Archived")}>
                  <Archive /> Archive
                </DropdownMenuItem>
              )}
              {s.status === "completed" && (
                <DropdownMenuItem onClick={() => onPatch({ status: "in_progress" }, "Moved to In progress")}>
                  <RotateCcw /> Mark as not done
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> {s.kind === "todo" ? "Delete to-do" : "Remove from Later"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

const iconBtn =
  "flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted";

function EditForm({ item, onSave, onCancel }: { item: SavedItem; onSave: (c: SavedPatch) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const isTodo = item.kind === "todo";
  const save = () => {
    const change: SavedPatch = {};
    if (isTodo) {
      const t = title.trim();
      if (!t) return;
      if (t !== item.title) change.title = t;
    }
    const n = notes.trim() || null;
    if (n !== (item.notes ?? null)) change.notes = n;
    if (Object.keys(change).length) onSave(change);
    else onCancel();
  };
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {isTodo && (
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="To-do" maxLength={500} />
      )}
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        autoFocus={!isTodo}
        placeholder="Add a note…"
        aria-label="Notes"
        rows={2}
        maxLength={2000}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isTodo && !title.trim()} className="bg-send text-white hover:bg-send/90">
          Save
        </Button>
      </div>
    </form>
  );
}
