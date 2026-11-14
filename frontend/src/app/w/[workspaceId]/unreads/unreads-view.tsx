"use client";

import { CheckCheck, ChevronDown, ChevronsDownUp, ChevronsUpDown, ExternalLink, Inbox, PartyPopper } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CatchUpButton, CatchUpCard } from "@/components/ai/catch-up";
import { MessageItem } from "@/components/chat/message-item";
import { ChannelTag, continues, threadPath } from "@/components/views/message-snippet";
import { usePaged } from "@/components/views/use-paged";
import { useListNav } from "@/components/views/use-list-nav";
import { EmptyState, ErrorBlock, KeyHint, LoadingList, ViewHeader, ViewPage } from "@/components/views/view-shell";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { applyMessageEvent } from "@/lib/messages";
import { productivity, type UnreadGroup } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const MAX_SHOWN = 20;

const newest = (g: UnreadGroup) => g.messages.at(-1)?.created_at ?? g.first_unread_at ?? "";

export function UnreadsView() {
  const ws = useWorkspace();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  /** Bumped by "Catch me up" so each click starts a fresh digest; null = hidden. */
  const [catchUp, setCatchUp] = useState<number | null>(null);

  const paged = usePaged(
    `${ws.workspaceId}:unreads`,
    () => productivity.unreads(ws.workspaceId).then((items) => ({ items, next_cursor: null })),
    (g: UnreadGroup) => g.channel_id,
  );
  const { setItems } = paged;
  const groups = paged.items ? [...paged.items].filter((g) => g.unread_count > 0).sort((a, b) => newest(b).localeCompare(newest(a))) : null;
  const total = groups?.reduce((n, g) => n + g.unread_count, 0) ?? 0;

  const openChannel = (channelId: string) => router.push(`/w/${ws.workspaceId}/c/${channelId}`);

  const nav = useListNav({
    scope: "unreads",
    count: groups?.length ?? 0,
    onOpen: (i) => groups?.[i] && openChannel(groups[i].channel_id),
  });

  useWorkspaceEvents((e) => {
    if (e.type === "resync") return paged.reload(true);
    if (e.type === "message.created") {
      const m = e.message;
      if (m.workspace_id !== ws.workspaceId || m.parent_id || m.author_id === ws.me?.id || m.kind === "system") {
        // Thread replies still bump reply counters on messages we show.
        if (m.parent_id) setItems((list) => list.map((g) => ({ ...g, messages: applyMessageEvent(g.messages, e, { channelId: g.channel_id, parentId: null }) })));
        return;
      }
      const channel = ws.channels.find((c) => c.id === m.channel_id);
      if (!channel?.is_member) return;
      setItems((list) => {
        const existing = list.find((g) => g.channel_id === m.channel_id);
        if (existing) {
          if (existing.messages.some((x) => x.id === m.id)) return list;
          return list.map((g) =>
            g.channel_id === m.channel_id
              ? { ...g, unread_count: g.unread_count + 1, messages: [...g.messages, m].slice(-MAX_SHOWN) }
              : g,
          );
        }
        return [{ channel_id: m.channel_id, unread_count: 1, first_unread_at: m.created_at, messages: [m] }, ...list];
      });
      return;
    }
    if (e.type === "message.updated" || e.type === "message.deleted" || e.type === "reaction.updated") {
      setItems((list) => {
        let changed = false;
        const next = list.map((g) => {
          const msgs = applyMessageEvent(g.messages, e, { channelId: g.channel_id, parentId: null });
          if (msgs === g.messages) return g;
          changed = true;
          return { ...g, messages: msgs };
        });
        return changed ? next : list;
      });
    }
  });

  /** Animate the group out, then drop it. */
  const dismiss = (ids: string[]) => {
    setLeaving((s) => new Set([...s, ...ids]));
    setTimeout(() => {
      setItems((list) => list.filter((g) => !ids.includes(g.channel_id)));
      setLeaving((s) => {
        const next = new Set(s);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }, 220);
  };

  const markRead = (g: UnreadGroup) => {
    ws.markRead(g.channel_id);
    dismiss([g.channel_id]);
  };

  const markAllRead = () => {
    const snapshot = paged.items ?? [];
    if (!snapshot.length) return;
    dismiss(snapshot.map((g) => g.channel_id));
    productivity
      .readAll(ws.workspaceId)
      .then(() => {
        toast.success("Everything marked as read");
        return ws.reloadChannels();
      })
      .catch((err) => {
        setItems(() => snapshot);
        toast.error(`Couldn't mark everything as read: ${errorMessage(err)}`);
      });
  };

  const allCollapsed = !!groups?.length && groups.every((g) => collapsed.has(g.channel_id));
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ViewPage label="Unreads">
      <ViewHeader
        icon={Inbox}
        title="Unreads"
        subtitle={groups ? (total ? `${total} unread in ${groups.length} ${groups.length === 1 ? "conversation" : "conversations"}` : undefined) : undefined}
        actions={
          <>
            <KeyHint />
            <CatchUpButton
              onClick={() => setCatchUp((n) => (n ?? 0) + 1)}
              active={catchUp !== null}
              disabled={!groups?.length && catchUp === null}
            />
            {!!groups?.length && (
              <button
                onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.channel_id)))}
                className="flex size-8 items-center justify-center rounded-lg border text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={allCollapsed ? "Expand all" : "Collapse all"}
                title={allCollapsed ? "Expand all" : "Collapse all"}
              >
                {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
              </button>
            )}
            <button
              onClick={markAllRead}
              disabled={!groups?.length}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <CheckCheck className="size-4" />
              <span className="hidden sm:inline">Mark all read</span>
            </button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto bg-muted/30">
        {paged.error && <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />}
        {catchUp !== null && (
          <div className="mx-auto max-w-4xl px-2 pt-2 sm:px-5 sm:pt-5">
            <CatchUpCard key={catchUp} onClose={() => setCatchUp(null)} />
          </div>
        )}
        {!groups && !paged.error && <LoadingList variant="card" rows={3} />}
        {groups?.length === 0 && (
          <EmptyState icon={PartyPopper} title="You're all caught up">
            New messages in your channels and DMs will collect here until you read them.
          </EmptyState>
        )}
        {groups && groups.length > 0 && (
          <div className={cn("mx-auto max-w-4xl space-y-3 p-2 sm:p-5", catchUp !== null && "pt-3 sm:pt-4")}>
            {groups.map((g, i) => {
              const isCollapsed = collapsed.has(g.channel_id);
              const hidden = Math.max(0, g.unread_count - g.messages.length);
              const channel = ws.channels.find((c) => c.id === g.channel_id);
              return (
                <section
                  key={g.channel_id}
                  {...nav.rowProps(i)}
                  onFocusCapture={() => nav.setIndex(i)}
                  aria-label={`Unread in ${channel ? ws.channelLabel(channel) : "conversation"}`}
                  className={cn(
                    "overflow-hidden rounded-xl border bg-background shadow-xs transition-all duration-200 data-[selected]:ring-2 data-[selected]:ring-tab",
                    leaving.has(g.channel_id) && "pointer-events-none -translate-y-1 opacity-0",
                  )}
                >
                  <header className="flex items-center gap-2 border-b bg-muted/30 px-2 py-1.5 sm:px-3">
                    <button
                      onClick={() => toggle(g.channel_id)}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? "Expand" : "Collapse"}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <ChevronDown className={cn("size-4 transition-transform", isCollapsed && "-rotate-90")} />
                    </button>
                    <ChannelTag channelId={g.channel_id} link className="text-sm" />
                    <span className="shrink-0 rounded-full bg-badge px-1.5 text-[11px] leading-4 font-bold text-badge-foreground">
                      {g.unread_count > 99 ? "99+" : g.unread_count}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <Link
                        href={`/w/${ws.workspaceId}/c/${g.channel_id}`}
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Open conversation"
                        title="Open conversation"
                      >
                        <ExternalLink className="size-4" />
                      </Link>
                      <button
                        onClick={() => markRead(g)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-semibold hover:bg-muted"
                      >
                        <CheckCheck className="size-3.5" />
                        <span className="hidden sm:inline">Mark as read</span>
                        <span className="sm:hidden">Read</span>
                      </button>
                    </div>
                  </header>
                  {!isCollapsed && (
                    <div className="py-1">
                      {hidden > 0 && (
                        <Link
                          href={`/w/${ws.workspaceId}/c/${g.channel_id}`}
                          className="mx-5 my-1 block rounded-md bg-muted/60 px-3 py-1.5 text-center text-xs font-semibold text-link hover:underline"
                        >
                          {hidden} earlier unread {hidden === 1 ? "message" : "messages"} · open the conversation
                        </Link>
                      )}
                      {g.messages.map((m, j) => (
                        <MessageItem
                          key={m.id}
                          message={m}
                          compact={continues(g.messages[j - 1], m)}
                          onOpenThread={(root) => router.push(threadPath(root))}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </ViewPage>
  );
}
