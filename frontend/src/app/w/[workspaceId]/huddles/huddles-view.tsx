"use client";

import {
  ExternalLink,
  Headphones,
  Loader2,
  MessagesSquare,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  StickyNote,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { CallAvatarStack } from "@/components/calls/avatar-stack";
import { formatDuration } from "@/components/calls/call-styles";
import type { CallOut } from "@/components/calls/types";
import { formatElapsed, useNow as useSecondClock } from "@/components/huddle/hooks";
import { useHuddles } from "@/components/huddle/huddle-provider";
import { Button } from "@/components/ui/button";
import { ChannelTag } from "@/components/views/message-snippet";
import { usePaged } from "@/components/views/use-paged";
import { SELECTED_ROW, useListNav } from "@/components/views/use-list-nav";
import { EmptyState, ErrorBlock, KeyHint, LoadMore, LoadingList, ViewHeader, ViewPage } from "@/components/views/view-shell";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { dayLabel, timeLabel } from "@/lib/messages";
import { productivity, type CallHistoryItem } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Live = { channelId: string; participantIds: string[]; startedAt: string | null; kind: "audio" | "video"; label: string };

const callLink = (ws: string, c: Pick<CallOut, "channel_id" | "message_id">, thread = false) => {
  if (!c.message_id) return `/w/${ws}/c/${c.channel_id}`;
  const p = new URLSearchParams({ msg: c.message_id });
  if (thread) p.set("thread", c.message_id);
  return `/w/${ws}/c/${c.channel_id}?${p}`;
};

export function HuddlesView() {
  const ws = useWorkspace();
  const huddles = useHuddles();
  const router = useRouter();

  // Active calls the server knows about (catches calls started before this page opened).
  const active = usePaged(
    `${ws.workspaceId}:calls:active`,
    () => productivity.calls(ws.workspaceId, { status: "active" }),
    (c: CallHistoryItem) => c.id,
  );
  const history = usePaged(
    `${ws.workspaceId}:calls:ended`,
    (cursor) => productivity.calls(ws.workspaceId, { status: "ended", cursor }),
    (c: CallHistoryItem) => c.id,
  );

  useWorkspaceEvents((e) => {
    if (e.type === "call.updated") {
      active.reload(true);
      if (e.call.status !== "active" && e.call.status !== "ringing") history.reload(true);
    } else if (e.type === "huddle.updated" && e.participant_ids.length === 0) {
      active.reload(true);
      history.reload(true);
    } else if (e.type === "resync") {
      active.reload(true);
      history.reload(true);
    } else if (e.type === "call.notes_updated") {
      history.reload(true);
    }
  });

  // Merge the live huddle registry (realtime) with the active calls list.
  const live: Live[] = [];
  const seen = new Set<string>();
  for (const h of Object.values(huddles.huddles)) {
    if (!h.participant_ids.length) continue;
    const hist = active.items?.find((c) => c.channel_id === h.channel_id);
    const call: CallOut | undefined = hist ?? huddles.calls[h.channel_id];
    seen.add(h.channel_id);
    live.push({
      channelId: h.channel_id,
      participantIds: h.participant_ids,
      startedAt: h.started_at ?? call?.started_at ?? null,
      kind: call?.kind ?? "audio",
      label: hist?.channel_label_hint ?? "",
    });
  }
  for (const c of active.items ?? []) {
    if (seen.has(c.channel_id) || (c.status !== "active" && c.status !== "ringing")) continue;
    // Only show active calls I can actually see people in (stale rows vanish once the registry empties).
    if (!c.participant_ids.length) continue;
    seen.add(c.channel_id);
    live.push({ channelId: c.channel_id, participantIds: c.participant_ids, startedAt: c.started_at, kind: c.kind, label: c.channel_label_hint });
  }

  const items = history.items;
  const nav = useListNav({
    scope: "huddles",
    count: items?.length ?? 0,
    onOpen: (i) => items?.[i] && router.push(callLink(ws.workspaceId, items[i])),
  });

  return (
    <ViewPage label="Huddles">
      <ViewHeader icon={Headphones} title="Huddles" subtitle="Live huddles and your call history" actions={<KeyHint />} />
      <div className="flex-1 overflow-y-auto">
        <section aria-labelledby="huddles-live" className="border-b px-3 py-4 sm:px-5">
          <h2 id="huddles-live" className="mb-3 flex items-center gap-2 text-sm font-black">
            <span className="relative flex size-2">
              {live.length > 0 && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
              <span className={cn("relative inline-flex size-2 rounded-full", live.length ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            </span>
            Active now
          </h2>
          {!live.length && !active.items && !active.error ? (
            <div className="h-20 animate-pulse rounded-xl border bg-muted/40" />
          ) : live.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {live.map((h) => (
                <LiveCard key={h.channelId} live={h} />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
              No one is in a huddle right now. Start one from any channel header with the headphones button.
            </p>
          )}
        </section>

        <section aria-labelledby="huddles-history">
          <h2 id="huddles-history" className="px-4 pt-4 pb-2 text-sm font-black sm:px-5">
            History
          </h2>
          {history.error && <ErrorBlock message={history.error} onRetry={() => history.reload()} />}
          {!items && !history.error && <LoadingList rows={4} />}
          {items?.length === 0 && (
            <EmptyState icon={Phone} title="No calls yet">
              Huddles and calls in your conversations will be listed here with who joined, how long they lasted and their notes.
            </EmptyState>
          )}
          {items && items.length > 0 && (
            <ul role="list">
              {items.map((c, i) => {
                const day = dayLabel(c.started_at);
                const newDay = i === 0 || dayLabel(items[i - 1].started_at) !== day;
                return (
                  <Fragment key={c.id}>
                    {newDay && (
                      <li aria-hidden className="sticky top-0 z-10 border-y bg-background/95 px-4 py-1.5 text-xs font-bold text-muted-foreground backdrop-blur sm:px-5">
                        {day}
                      </li>
                    )}
                    <li>
                      <HistoryRow call={c} navProps={nav.rowProps(i)} onSelect={() => nav.setIndex(i)} />
                    </li>
                  </Fragment>
                );
              })}
              <li>
                <LoadMore hasMore={history.hasMore} loading={history.loadingMore} error={history.moreError} onMore={history.loadMore} />
              </li>
            </ul>
          )}
        </section>
      </div>
    </ViewPage>
  );
}

function LiveCard({ live: h }: { live: Live }) {
  const huddles = useHuddles();
  const clock = useSecondClock();
  const [joining, setJoining] = useState(false);
  const inIt = huddles.activeChannelId === h.channelId;
  const elapsed = h.startedAt && clock ? formatElapsed(clock - new Date(h.startedAt).getTime()) : null;

  const join = () => {
    setJoining(true);
    huddles
      .join(h.channelId)
      .catch((err) => toast.error(`Couldn't join: ${errorMessage(err)}`))
      .finally(() => setJoining(false));
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-emerald-500/[0.04] p-4 ring-1 ring-emerald-500/20">
      <div className="flex items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white">
          {h.kind === "video" ? <Video className="size-4" /> : <Headphones className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <ChannelTag channelId={h.channelId} fallback={h.label} link className="text-sm" />
          <p className="text-xs text-muted-foreground tabular-nums">
            {h.participantIds.length} {h.participantIds.length === 1 ? "person" : "people"}
            {elapsed && ` · ${elapsed}`}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <CallAvatarStack ids={h.participantIds} max={5} ringClassName="ring-background" />
        {inIt ? (
          <Button size="sm" variant="destructive" onClick={() => huddles.leave()}>
            <PhoneOff className="size-3.5" /> Leave
          </Button>
        ) : (
          <Button size="sm" disabled={joining} onClick={join} className="bg-emerald-600 text-white hover:bg-emerald-600/90">
            {joining ? <Loader2 className="size-3.5 animate-spin" /> : <Headphones className="size-3.5" />} Join
          </Button>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ call: c, navProps, onSelect }: { call: CallHistoryItem; navProps: Record<string, unknown>; onSelect: () => void }) {
  const ws = useWorkspace();
  const missed = c.status === "missed" || c.status === "declined" || c.status === "cancelled";
  const iStarted = c.started_by === ws.me?.id;
  const seconds = c.ended_at ? (new Date(c.ended_at).getTime() - new Date(c.started_at).getTime()) / 1000 : null;
  const Icon = missed ? PhoneMissed : c.kind === "video" ? Video : iStarted ? Phone : PhoneIncoming;
  const statusText =
    c.status === "missed"
      ? iStarted
        ? "No answer"
        : "Missed"
      : c.status === "declined"
        ? "Declined"
        : c.status === "cancelled"
          ? "Cancelled"
          : seconds !== null
            ? formatDuration(seconds)
            : "Ended";
  const people = c.joined_ids.length ? c.joined_ids : [c.started_by];

  return (
    <div
      {...navProps}
      onFocusCapture={onSelect}
      className={cn("group flex gap-3 border-b px-4 py-3 hover:bg-muted/40 sm:px-5", SELECTED_ROW)}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
          missed ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <ChannelTag channelId={c.channel_id} fallback={c.channel_label_hint} link className="text-sm" />
          <span className={cn("text-xs font-semibold", missed ? "text-destructive" : "text-muted-foreground")}>{statusText}</span>
          <span className="text-xs text-muted-foreground">
            {timeLabel(c.started_at)}
            {c.ended_at && !missed && ` – ${timeLabel(c.ended_at)}`}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <CallAvatarStack ids={people} max={6} size="sm" ringClassName="ring-background" />
          <span className="truncate text-xs text-muted-foreground">
            {c.kind === "video" ? "Video call" : "Huddle"} · started by {ws.memberById[c.started_by]?.full_name ?? "someone"}
          </span>
        </div>
        {c.notes_preview && (
          <Link
            href={callLink(ws.workspaceId, c, true)}
            className="mt-2 flex gap-2 rounded-lg border bg-muted/30 p-2.5 text-sm hover:bg-muted/60"
          >
            <StickyNote className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span className="line-clamp-2 text-muted-foreground">{c.notes_preview}</span>
          </Link>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        {c.message_id && (
          <Link
            href={callLink(ws.workspaceId, c, true)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Open thread"
            title="Open thread"
          >
            <MessagesSquare className="size-4" />
          </Link>
        )}
        <Link
          href={callLink(ws.workspaceId, c)}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Open in channel"
          title="Open in channel"
        >
          <ExternalLink className="size-4" />
        </Link>
      </div>
    </div>
  );
}
