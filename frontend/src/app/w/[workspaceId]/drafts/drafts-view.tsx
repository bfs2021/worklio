"use client";

import {
  CalendarClock,
  Clock,
  ExternalLink,
  FilePen,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Send,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { useNow } from "@/components/profile/profile-utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { deleteDraft, useDraftList, type DraftEntry } from "@/components/views/draft-list";
import { ChannelTag, MessageSnippet } from "@/components/views/message-snippet";
import { TimePicker } from "@/components/views/time-picker";
import { usePaged } from "@/components/views/use-paged";
import { SELECTED_ROW, useListNav } from "@/components/views/use-list-nav";
import {
  EmptyState,
  ErrorBlock,
  KeyHint,
  LoadMore,
  LoadingList,
  ViewHeader,
  ViewPage,
  ViewTabs,
} from "@/components/views/view-shell";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { decodeMentions, encodeMentions, formatMessage } from "@/lib/format";
import { messagePath } from "@/lib/messages";
import { productivity, whenLabel, type MessageOut, type ScheduledMessage } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Tab = "drafts" | "scheduled" | "sent";

const iconBtn =
  "flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted";

const draftHref = (ws: string, d: Pick<DraftEntry, "channelId" | "parentId">) =>
  d.parentId
    ? `/w/${ws}/c/${d.channelId}?${new URLSearchParams({ msg: d.parentId, thread: d.parentId })}`
    : `/w/${ws}/c/${d.channelId}`;

export function DraftsView() {
  const ws = useWorkspace();
  const [tab, setTab] = useState<Tab>("drafts");
  const allDrafts = useDraftList();
  // Drafts live in this browser for every workspace: only show this workspace's conversations.
  const channelIds = new Set(ws.channels.map((c) => c.id));
  const draftList = allDrafts.filter((d) => channelIds.has(d.channelId));
  const [scheduledCount, setScheduledCount] = useState<number | null>(null);

  return (
    <ViewPage label="Drafts and sent">
      <ViewHeader icon={SendHorizontal} title="Drafts & sent" subtitle="Unsent drafts, scheduled messages and what you've sent">
        <ViewTabs
          label="Drafts and sent"
          tabs={[
            { key: "drafts", label: "Drafts", count: draftList.length },
            { key: "scheduled", label: "Scheduled", count: scheduledCount ?? undefined },
            { key: "sent", label: "Sent" },
          ]}
          value={tab}
          onChange={setTab}
          trailing={<KeyHint />}
        />
      </ViewHeader>
      <div className="flex-1 overflow-y-auto">
        {tab === "drafts" && <DraftsTab drafts={draftList} loaded={ws.channelsLoaded} />}
        {tab === "scheduled" && <ScheduledTab onCount={setScheduledCount} />}
        {tab === "sent" && <SentTab />}
      </div>
    </ViewPage>
  );
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function DraftsTab({ drafts, loaded }: { drafts: DraftEntry[]; loaded: boolean }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [confirm, setConfirm] = useState<DraftEntry | null>(null);
  const nav = useListNav({
    scope: "drafts",
    count: drafts.length,
    onOpen: (i) => drafts[i] && router.push(draftHref(ws.workspaceId, drafts[i])),
  });

  if (!loaded) return <LoadingList rows={3} />;
  if (!drafts.length)
    return (
      <EmptyState icon={FilePen} title="No drafts">
        Anything you type but don&apos;t send is saved here automatically, so you can pick up where you left off.
      </EmptyState>
    );

  return (
    <>
      <ul role="list">
        {drafts.map((d, i) => (
          <li key={d.key}>
            <div {...nav.rowProps(i)} className={cn("group flex gap-3 border-b px-4 py-3 hover:bg-muted/40 sm:px-5", SELECTED_ROW)}>
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {d.parentId ? <MessagesSquare className="size-4" /> : <FilePen className="size-4" />}
              </span>
              <Link href={draftHref(ws.workspaceId, d)} className="min-w-0 flex-1" onFocus={() => nav.setIndex(i)}>
                <div className="flex items-center gap-1.5 text-[13px]">
                  <ChannelTag channelId={d.channelId} />
                  {d.parentId && <span className="text-muted-foreground">· thread reply</span>}
                </div>
                <p className="mt-0.5 line-clamp-3 text-msg break-words whitespace-pre-wrap text-muted-foreground">
                  {decodeMentions(d.body, ws.memberById)}
                </p>
              </Link>
              <div className="flex shrink-0 items-start gap-0.5">
                <Link href={draftHref(ws.workspaceId, d)} className={iconBtn} aria-label="Open draft" title="Open draft">
                  <Pencil className="size-4" />
                </Link>
                <button onClick={() => setConfirm(d)} className={iconBtn} aria-label="Delete draft" title="Delete draft">
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete draft?"
        description="This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirm) deleteDraft(confirm);
          setConfirm(null);
          toast.success("Draft deleted");
        }}
      >
        {confirm && (
          <p className="line-clamp-4 rounded-md border bg-muted/40 p-2 text-sm whitespace-pre-wrap">
            {decodeMentions(confirm.body, ws.memberById)}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scheduled
// ---------------------------------------------------------------------------

const scheduledOrder = (a: ScheduledMessage, b: ScheduledMessage) => a.send_at.localeCompare(b.send_at);

function ScheduledTab({ onCount }: { onCount: (n: number) => void }) {
  const ws = useWorkspace();
  const now = useNow();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ScheduledMessage | null>(null);
  const paged = usePaged(
    `${ws.workspaceId}:scheduled`,
    () => productivity.scheduled(ws.workspaceId).then((items) => ({ items, next_cursor: null })),
    (s: ScheduledMessage) => s.id,
  );
  const { setItems, reload } = paged;
  const items = paged.items
    ? paged.items.filter((s) => s.status === "pending" || s.status === "failed").sort(scheduledOrder)
    : null;
  const pendingCount = items?.filter((s) => s.status === "pending").length;

  // Report the badge count to the tab strip (outside render).
  useEffect(() => {
    if (pendingCount !== undefined) onCount(pendingCount);
  }, [pendingCount, onCount]);

  // Once a pending message's time passes, refetch so it moves out (the worker sends it within ~30 s).
  const nextDue = items?.find((s) => s.status === "pending")?.send_at;
  useEffect(() => {
    if (!nextDue || !now) return;
    const wait = Math.max(5_000, new Date(nextDue).getTime() - now + 35_000);
    const t = setTimeout(() => reload(true), Math.min(wait, 2_147_000_000));
    return () => clearTimeout(t);
  }, [nextDue, now, reload]);

  useWorkspaceEvents((e) => {
    if (e.type === "resync") reload(true);
  });

  const patchLocal = (id: string, fn: (s: ScheduledMessage) => ScheduledMessage) =>
    setItems((list) => list.map((s) => (s.id === id ? fn(s) : s)));

  const update = (s: ScheduledMessage, change: { body?: string; send_at?: string }, done: string) => {
    patchLocal(s.id, (x) => ({ ...x, ...change }));
    productivity
      .updateScheduled(s.id, change)
      .then((saved) => {
        patchLocal(s.id, () => saved);
        toast.success(done);
      })
      .catch((err) => {
        patchLocal(s.id, () => s);
        toast.error(`Couldn't update: ${errorMessage(err)}`);
      });
  };

  const removeLocal = (s: ScheduledMessage) => setItems((list) => list.filter((x) => x.id !== s.id));
  const restoreLocal = (s: ScheduledMessage) => setItems((list) => (list.some((x) => x.id === s.id) ? list : [...list, s]));

  const sendNow = (s: ScheduledMessage) => {
    removeLocal(s);
    productivity
      .sendScheduledNow(s.id)
      .then(() => toast.success("Message sent"))
      .catch((err) => {
        restoreLocal(s);
        toast.error(`Couldn't send: ${errorMessage(err)}`);
      });
  };

  const nav = useListNav({
    scope: "scheduled",
    count: items?.length ?? 0,
    onOpen: (i) => items?.[i] && setEditing(items[i].id),
  });

  if (paged.error) return <ErrorBlock message={paged.error} onRetry={() => reload()} />;
  if (!items) return <LoadingList rows={3} />;
  if (!items.length)
    return (
      <EmptyState icon={CalendarClock} title="Nothing scheduled">
        Schedule a message from the composer&apos;s send menu, or type <code className="rounded bg-muted px-1">/schedule</code>,
        and it will wait here until it&apos;s time.
      </EmptyState>
    );

  return (
    <>
      <ul role="list">
        {items.map((s, i) => (
          <li key={s.id}>
            <div {...nav.rowProps(i)} className={cn("group flex gap-3 border-b px-4 py-3 hover:bg-muted/40 sm:px-5", SELECTED_ROW)}>
              <span
                className={cn(
                  "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
                  s.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-mention text-mention-foreground",
                )}
              >
                <Clock className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 text-[13px]">
                  <ChannelTag channelId={s.channel_id} link />
                  {s.parent_id && <span className="text-muted-foreground">· thread reply</span>}
                  <span className={cn("font-semibold", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    · {s.status === "failed" ? "Failed to send" : `Sends ${whenLabel(s.send_at, now)}`}
                  </span>
                  {!!s.attachment_ids.length && (
                    <span className="text-muted-foreground">
                      · {s.attachment_ids.length} {s.attachment_ids.length === 1 ? "file" : "files"}
                    </span>
                  )}
                </div>
                {editing === s.id ? (
                  <EditBody
                    initial={decodeMentions(s.body, ws.memberById)}
                    onCancel={() => setEditing(null)}
                    onSave={(text) => {
                      setEditing(null);
                      const body = encodeMentions(text, ws.members);
                      if (body !== s.body) update(s, { body }, "Scheduled message updated");
                    }}
                  />
                ) : (
                  <div className="mt-0.5 line-clamp-4 text-msg break-words whitespace-pre-wrap">
                    {formatMessage(s.body, { names: ws.memberById, meId: ws.me?.id })}
                  </div>
                )}
              </div>
              {editing !== s.id && (
                <div className="flex shrink-0 items-start gap-0.5">
                  <TimePicker
                    title="Reschedule"
                    value={s.send_at}
                    allowClear={false}
                    maxDays={120}
                    onChange={(v) => v && update(s, { send_at: v }, `Rescheduled for ${whenLabel(v, Date.now())}`)}
                    triggerLabel="Reschedule"
                    triggerClassName={iconBtn}
                  >
                    <CalendarClock className="size-4" />
                  </TimePicker>
                  <button onClick={() => sendNow(s)} className={iconBtn} aria-label="Send now" title="Send now">
                    <Send className="size-4" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger className={iconBtn} aria-label="More actions">
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => setEditing(s.id)}>
                        <Pencil /> Edit message
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<Link href={`/w/${ws.workspaceId}/c/${s.channel_id}`} />}>
                        <ExternalLink /> Open conversation
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setConfirm(s)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete scheduled message?"
        description="It won't be sent. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          const s = confirm;
          if (!s) return;
          removeLocal(s);
          try {
            await productivity.deleteScheduled(s.id);
            toast.success("Scheduled message deleted");
          } catch (err) {
            restoreLocal(s);
            throw err;
          }
        }}
      />
    </>
  );
}

function EditBody({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <form
      className="mt-1.5 grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSave(text.trim());
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        rows={3}
        aria-label="Message"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (text.trim()) onSave(text.trim());
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">Enter to save · Esc to cancel</span>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!text.trim()} className="bg-send text-white hover:bg-send/90">
          Save
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sent
// ---------------------------------------------------------------------------

function SentTab() {
  const ws = useWorkspace();
  const router = useRouter();
  const paged = usePaged(
    `${ws.workspaceId}:sent`,
    (cursor) => productivity.sent(ws.workspaceId, cursor),
    (m: MessageOut) => m.id,
  );
  const { items, setItems } = paged;

  useWorkspaceEvents((e) => {
    if (e.type === "resync") return paged.reload(true);
    if (e.type === "message.created") {
      const m = e.message;
      if (m.author_id !== ws.me?.id || m.workspace_id !== ws.workspaceId || m.kind === "system") return;
      setItems((list) => (list.some((x) => x.id === m.id) ? list : [m, ...list]));
    } else if (e.type === "message.updated") {
      setItems((list) => (list.some((x) => x.id === e.message.id) ? list.map((x) => (x.id === e.message.id ? { ...x, ...e.message } : x)) : list));
    } else if (e.type === "message.deleted") {
      setItems((list) => list.filter((x) => x.id !== e.message_id));
    }
  });

  const nav = useListNav({
    scope: "sent",
    count: items?.length ?? 0,
    onOpen: (i) => items?.[i] && router.push(messagePath(items[i]), { scroll: false }),
  });

  if (paged.error) return <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />;
  if (!items) return <LoadingList />;
  if (!items.length)
    return (
      <EmptyState icon={Send} title="Nothing sent yet">
        Messages you send in channels, DMs and threads will be listed here.
      </EmptyState>
    );

  return (
    <ul role="list">
      {items.map((m, i) => (
        <li key={m.id}>
          <Link
            href={messagePath(m)}
            scroll={false}
            {...nav.rowProps(i)}
            onFocus={() => nav.setIndex(i)}
            className={cn("block border-b px-4 py-3 outline-none hover:bg-muted/40 focus-visible:bg-muted/70 sm:px-5", SELECTED_ROW)}
          >
            <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
              <ChannelTag channelId={m.channel_id} />
              {m.parent_id && <span>· thread reply</span>}
            </div>
            <MessageSnippet message={m} clamp={3} />
          </Link>
        </li>
      ))}
      <li>
        <LoadMore hasMore={paged.hasMore} loading={paged.loadingMore} error={paged.moreError} onMore={paged.loadMore} />
      </li>
    </ul>
  );
}
