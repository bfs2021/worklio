"use client";

import { Loader2, Pin, PinOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SidePanel } from "@/components/chat/side-panel";
import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import type { Message } from "@/lib/api";
import { formatMessage } from "@/lib/format";
import { dayLabel, media, messagePath, timeLabel } from "@/lib/messages";
import { messaging, rich } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { useGroupsById } from "./use-groups";

export type PinsState = {
  pins: Message[] | null;
  error: string;
  reload: () => void;
  /** Optimistically drop a pin (unpin from the panel). */
  remove: (id: string) => void;
};

/** A channel's pinned messages, kept live from message.updated / message.deleted events. */
export function usePins(channelId: string): PinsState {
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    messaging
      .pins(channelId)
      .then((list) => {
        if (!live) return;
        setPins(list);
        setError("");
      })
      .catch((err) => {
        if (!live) return;
        setPins((p) => p ?? []);
        setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  useWorkspaceEvents((e) => {
    if (e.type === "message.updated" && e.message.channel_id === channelId) {
      const m = e.message;
      const pinned = !!rich(m).pinned;
      setPins((list) => {
        if (!list) return list;
        const has = list.some((x) => x.id === m.id);
        if (pinned) return has ? list.map((x) => (x.id === m.id ? m : x)) : [m, ...list];
        return has ? list.filter((x) => x.id !== m.id) : list;
      });
    } else if (e.type === "message.deleted" && e.channel_id === channelId) {
      setPins((list) => (list?.some((x) => x.id === e.message_id) ? list.filter((x) => x.id !== e.message_id) : list));
    } else if (e.type === "resync") {
      setAttempt((n) => n + 1);
    }
  });

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const remove = useCallback((id: string) => setPins((list) => list?.filter((x) => x.id !== id) ?? list), []);
  return { pins, error, reload, remove };
}

/** Header button: "📌 3". */
export function PinsButton({ count, active, onClick }: { count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={count ? `${count} pinned ${count === 1 ? "message" : "messages"}` : "Pinned messages"}
      aria-label="Pinned messages"
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[13px] font-bold hover:bg-muted",
        active && "bg-muted",
      )}
    >
      <Pin className="size-3.5" />
      {count > 0 && <span className="tabular-nums">{count}</span>}
    </button>
  );
}

export function PinsPanel({ state, channelName, onClose }: { state: PinsState; channelName: string; onClose: () => void }) {
  const { pins, error, reload, remove } = state;
  return (
    <SidePanel title="Pinned" subtitle={channelName} onClose={onClose}>
      <div className="flex-1 overflow-y-auto">
        {pins === null && <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />}
        {error && (
          <p className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
            Couldn&apos;t load pins: {error}.{" "}
            <button onClick={reload} className="font-bold underline">
              Try again
            </button>
          </p>
        )}
        {pins?.length === 0 && !error && (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-mention text-mention-foreground">
              <Pin className="size-6" />
            </div>
            <p className="font-bold">No pinned messages yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pin important messages from the message menu so everyone can find them here.
            </p>
          </div>
        )}
        {pins?.map((m) => (
          <PinRow
            key={m.id}
            message={m}
            onUnpinned={() => remove(m.id)}
            onRestore={reload}
            // Below lg the panel covers the conversation: get out of the way so the jump is visible.
            onNavigate={() => media.overlayPanels() && onClose()}
          />
        ))}
      </div>
    </SidePanel>
  );
}

function PinRow({
  message: m,
  onUnpinned,
  onRestore,
  onNavigate,
}: {
  message: Message;
  onUnpinned: () => void;
  onRestore: () => void;
  onNavigate: () => void;
}) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const author = ws.memberById[m.author_id]?.full_name ?? "Unknown";
  const pinnedBy = rich(m).pinned_by;
  const unpin = async () => {
    onUnpinned();
    try {
      await messaging.unpin(m.id);
      toast.success("Unpinned");
    } catch (err) {
      onRestore();
      toast.error(`Couldn't unpin: ${errorMessage(err)}`);
    }
  };
  return (
    <div className="group/pin relative border-b hover:bg-muted/60">
      <Link
        href={messagePath(m)}
        scroll={false}
        onClick={() => {
          ws.setSidebarOpen(false);
          onNavigate();
        }}
        className="block px-4 py-3 pr-10"
      >
        <div className="flex gap-2.5">
          <UserAvatar id={m.author_id} name={author} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-msg font-black">{author}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {dayLabel(m.created_at)} at {timeLabel(m.created_at)}
              </span>
            </div>
            <div className="line-clamp-4 text-msg break-words whitespace-pre-wrap">
              {m.body ? (
                formatMessage(m.body, { names: ws.memberById, meId: ws.me?.id, groups })
              ) : rich(m).poll ? (
                <em className="text-muted-foreground">Poll: {rich(m).poll?.question}</em>
              ) : (
                <em className="text-muted-foreground">Shared a file</em>
              )}
            </div>
            {pinnedBy && (
              <p className="mt-1 text-xs text-muted-foreground">
                Pinned by {pinnedBy === ws.me?.id ? "you" : (ws.memberById[pinnedBy]?.full_name ?? "someone")}
              </p>
            )}
          </div>
        </div>
      </Link>
      <button
        type="button"
        onClick={unpin}
        aria-label="Unpin message"
        title="Unpin"
        className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/pin:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <PinOff className="size-4" />
      </button>
    </div>
  );
}
