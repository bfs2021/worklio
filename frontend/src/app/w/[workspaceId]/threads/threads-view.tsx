"use client";

import { BellOff, CheckCheck, ChevronDown, ExternalLink, Loader2, MessagesSquare, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { UserAvatar } from "@/components/chat/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChannelTag, continues, threadPath } from "@/components/views/message-snippet";
import { usePaged } from "@/components/views/use-paged";
import { useListNav } from "@/components/views/use-list-nav";
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
import { api, type Message, type RealtimeEvent } from "@/lib/api";
import { asProductivityEvent, productivity, type ThreadItem } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Tab = "all" | "unread";
const TABS = [
  { key: "all", label: "All threads" },
  { key: "unread", label: "Unread" },
] as const;

const lastActivity = (t: ThreadItem) => new Date(t.last_reply_at ?? t.root.created_at).getTime();

/** Apply a message/reaction event to one thread item (root + its loaded replies). */
function applyToThread(t: ThreadItem, e: RealtimeEvent, meId: string | undefined): ThreadItem {
  switch (e.type) {
    case "message.created": {
      const m = e.message;
      if (m.parent_id !== t.root.id || t.latest_replies.some((r) => r.id === m.id)) return t;
      return {
        ...t,
        reply_count: t.reply_count + 1,
        last_reply_at: m.created_at,
        participant_ids: t.participant_ids.includes(m.author_id) ? t.participant_ids : [...t.participant_ids, m.author_id],
        latest_replies: [...t.latest_replies, m],
        root: { ...t.root, reply_count: t.root.reply_count + 1, last_reply_at: m.created_at },
        // My own replies never count as unread; the server's thread.updated is authoritative for others.
        unread_count: m.author_id === meId ? 0 : t.unread_count,
      };
    }
    case "message.updated": {
      const m = e.message;
      if (m.id === t.root.id) return { ...t, root: { ...m, reply_count: t.root.reply_count } };
      if (!t.latest_replies.some((r) => r.id === m.id)) return t;
      return { ...t, latest_replies: t.latest_replies.map((r) => (r.id === m.id ? m : r)) };
    }
    case "message.deleted": {
      if (e.message_id === t.root.id) return { ...t, root: { ...t.root, deleted_at: new Date().toISOString(), body: "" } };
      if (e.parent_id !== t.root.id) return t;
      return {
        ...t,
        reply_count: Math.max(0, t.reply_count - 1),
        latest_replies: t.latest_replies.filter((r) => r.id !== e.message_id),
      };
    }
    case "reaction.updated": {
      if (e.message_id === t.root.id) return { ...t, root: { ...t.root, reactions: e.reactions } };
      if (!t.latest_replies.some((r) => r.id === e.message_id)) return t;
      return {
        ...t,
        latest_replies: t.latest_replies.map((r) => (r.id === e.message_id ? { ...r, reactions: e.reactions } : r)),
      };
    }
    default:
      return t;
  }
}

export function ThreadsView() {
  const ws = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const paged = usePaged(
    `${ws.workspaceId}:${tab}`,
    (cursor) => productivity.threads(ws.workspaceId, { unreadOnly: tab === "unread", cursor }),
    (t: ThreadItem) => t.root.id,
  );
  const { items, setItems } = paged;
  const unreadTotal = items?.filter((t) => t.unread_count > 0).length ?? 0;

  const nav = useListNav({
    scope: "threads",
    count: items?.length ?? 0,
    onOpen: (i) => {
      const box = document.querySelector<HTMLTextAreaElement>(`[data-nav-scope="threads"][data-nav-index="${i}"] textarea`);
      box?.focus();
    },
  });

  useWorkspaceEvents((e) => {
    const p = asProductivityEvent(e);
    if (p?.type === "thread.updated") {
      const known = items?.some((t) => t.root.id === p.root_id);
      if (known) setItems((list) => list.map((t) => (t.root.id === p.root_id ? { ...t, unread_count: p.unread_count } : t)));
      else if (p.unread_count > 0 || tab === "all") paged.reload(true);
      return;
    }
    if (e.type === "resync") return paged.reload(true);
    if (e.type === "message.created" || e.type === "message.updated" || e.type === "message.deleted" || e.type === "reaction.updated") {
      setItems((list) => {
        let changed = false;
        const next = list.map((t) => {
          const n = applyToThread(t, e, ws.me?.id);
          if (n !== t) changed = true;
          return n;
        });
        if (!changed) return list;
        // Newest activity first, like the server orders them.
        return e.type === "message.created" ? [...next].sort((a, b) => lastActivity(b) - lastActivity(a)) : next;
      });
    }
  });

  const markRead = (rootId: string) => {
    const before = items?.find((t) => t.root.id === rootId)?.unread_count ?? 0;
    if (!before) return;
    setItems((list) => list.map((t) => (t.root.id === rootId ? { ...t, unread_count: 0 } : t)));
    productivity.markThreadRead(rootId).catch(() => {
      setItems((list) => list.map((t) => (t.root.id === rootId ? { ...t, unread_count: before } : t)));
    });
  };

  const unfollow = (rootId: string) => {
    const snapshot = items ?? [];
    const idx = snapshot.findIndex((t) => t.root.id === rootId);
    const removed = snapshot[idx];
    if (!removed) return;
    setItems((list) => list.filter((t) => t.root.id !== rootId));
    productivity
      .unfollowThread(rootId)
      .then(() => toast.success("You'll no longer get updates from this thread"))
      .catch((err) => {
        setItems((list) => {
          if (list.some((t) => t.root.id === rootId)) return list;
          const next = [...list];
          next.splice(Math.min(idx, next.length), 0, removed);
          return next;
        });
        toast.error(`Couldn't unfollow: ${errorMessage(err)}`);
      });
  };

  const markAllRead = () => {
    const unread = (items ?? []).filter((t) => t.unread_count > 0);
    if (!unread.length) return;
    setItems((list) => list.map((t) => ({ ...t, unread_count: 0 })));
    Promise.allSettled(unread.map((t) => productivity.markThreadRead(t.root.id))).then((res) => {
      const failed = unread.filter((_, i) => res[i].status === "rejected");
      if (!failed.length) return;
      const counts = new Map(failed.map((t) => [t.root.id, t.unread_count]));
      setItems((list) => list.map((t) => (counts.has(t.root.id) ? { ...t, unread_count: counts.get(t.root.id)! } : t)));
      toast.error("Some threads couldn't be marked as read");
    });
  };

  return (
    <ViewPage label="Threads">
      <ViewHeader
        icon={MessagesSquare}
        title="Threads"
        subtitle="Conversations you started, replied to or were mentioned in"
        actions={
          <button
            onClick={markAllRead}
            disabled={!unreadTotal}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            <CheckCheck className="size-4" />
            <span className="hidden sm:inline">Mark all read</span>
          </button>
        }
      >
        <ViewTabs
          label="Thread filters"
          tabs={TABS.map((t) => ({ ...t, count: t.key === "unread" ? unreadTotal : undefined }))}
          value={tab}
          onChange={setTab}
          trailing={<KeyHint>to reply</KeyHint>}
        />
      </ViewHeader>

      <div className="flex-1 overflow-y-auto bg-muted/30">
        {paged.error && <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />}
        {!items && !paged.error && <LoadingList variant="card" rows={4} />}
        {items?.length === 0 && (
          <EmptyState icon={MessagesSquare} title={tab === "unread" ? "No unread threads" : "No threads yet"}>
            {tab === "unread"
              ? "You're all caught up on every thread you follow."
              : "Reply to a message, or get @mentioned in a thread, and it will show up here."}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <div className="mx-auto max-w-4xl space-y-3 p-2 sm:p-5">
            {items.map((t, i) => (
              <ThreadCard
                key={t.root.id}
                thread={t}
                navProps={nav.rowProps(i)}
                onSelect={() => nav.setIndex(i)}
                onRead={() => markRead(t.root.id)}
                onUnfollow={() => unfollow(t.root.id)}
                onOpen={() => router.push(threadPath(t.root))}
                onReplies={(replies) =>
                  setItems((list) =>
                    list.map((x) => (x.root.id === t.root.id ? { ...x, latest_replies: replies, reply_count: replies.length } : x)),
                  )
                }
                onSent={(m) => setItems((list) => list.map((x) => applyToThread(x, { type: "message.created", message: m }, ws.me?.id)))}
              />
            ))}
            <LoadMore
              hasMore={paged.hasMore}
              loading={paged.loadingMore}
              error={paged.moreError}
              onMore={paged.loadMore}
            />
          </div>
        )}
      </div>
    </ViewPage>
  );
}

function ThreadCard({
  thread: t,
  navProps,
  onSelect,
  onRead,
  onUnfollow,
  onOpen,
  onReplies,
  onSent,
}: {
  thread: ThreadItem;
  navProps: Record<string, unknown>;
  onSelect: () => void;
  onRead: () => void;
  onUnfollow: () => void;
  onOpen: () => void;
  onReplies: (replies: Message[]) => void;
  onSent: (m: Message) => void;
}) {
  const ws = useWorkspace();
  const ref = useRef<HTMLElement>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const unread = t.unread_count > 0;
  const hidden = Math.max(0, t.reply_count - t.latest_replies.length);
  const channel = ws.channels.find((c) => c.id === t.channel_id);

  // Mark read once the card has been on screen for a moment.
  const readRef = useRef(onRead);
  useEffect(() => {
    readRef.current = onRead;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || !unread) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !document.hidden) {
          timer ??= setTimeout(() => readRef.current(), 1200);
        } else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [unread]);

  const showAll = () => {
    setLoadingAll(true);
    api<Message[]>(`/messages/${t.root.id}/replies`)
      .then(onReplies)
      .catch((err) => toast.error(`Couldn't load replies: ${errorMessage(err)}`))
      .finally(() => setLoadingAll(false));
  };

  return (
    <article
      ref={ref}
      {...navProps}
      onFocusCapture={onSelect}
      aria-label={`Thread in ${channel ? ws.channelLabel(channel) : "a conversation"}`}
      className={cn(
        "overflow-hidden rounded-xl border bg-background shadow-xs transition-shadow",
        unread && "ring-1 ring-tab/40",
        "data-[selected]:ring-2 data-[selected]:ring-tab",
      )}
    >
      <header className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 sm:px-4">
        {unread && <span className="size-2 shrink-0 rounded-full bg-tab" aria-label="Unread" />}
        <ChannelTag channelId={t.channel_id} link className="text-[13px]" />
        <span className="hidden items-center -space-x-1 sm:flex" aria-label={`${t.participant_ids.length} participants`}>
          {t.participant_ids.slice(0, 5).map((id) => (
            <UserAvatar key={id} id={id} name={ws.memberById[id]?.full_name ?? "?"} size="sm" className="rounded ring-2 ring-background" />
          ))}
        </span>
        {unread && (
          <span className="rounded-full bg-badge px-1.5 text-[11px] leading-4 font-bold text-badge-foreground">
            {t.unread_count} new
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Link
            href={threadPath(t.root)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Open in channel"
            title="Open in channel"
          >
            <ExternalLink className="size-4" />
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Thread actions"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={onOpen}>
                <ExternalLink /> Open in channel
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!unread} onClick={onRead}>
                <CheckCheck /> Mark as read
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onUnfollow}>
                <BellOff /> Unfollow thread
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="py-1">
        <MessageItem message={t.root} compact={false} onOpenThread={onOpen} />
      </div>

      {hidden > 0 && (
        <button
          onClick={showAll}
          disabled={loadingAll}
          className="ml-5 flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-bold text-link hover:bg-muted sm:ml-[60px]"
        >
          {loadingAll ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}
          Show {hidden} more {hidden === 1 ? "reply" : "replies"}
        </button>
      )}

      {t.latest_replies.length > 0 && (
        <div className="border-l-2 border-muted py-1 sm:ml-9">
          {t.latest_replies.map((r, i) => (
            <MessageItem key={r.id} message={r} compact={continues(t.latest_replies[i - 1], r)} />
          ))}
        </div>
      )}

      <div className="border-t px-1 pt-1 sm:px-2">
        <Composer channelId={t.channel_id} parentId={t.root.id} placeholder="Reply…" onSent={onSent} />
      </div>
    </article>
  );
}
