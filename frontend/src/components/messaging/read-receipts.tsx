"use client";

import { CheckCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import type { Message } from "@/lib/api";
import { asMessagingEvent, messaging, type ReadState } from "@/lib/messaging";

/**
 * "Seen" (1:1 DM) / "Seen by 3" (group DM) under my latest message, from
 * GET /channels/{id}/read-state kept live by `channel.read` events.
 */
export function ReadReceipt({ message: m }: { message: Message }) {
  const ws = useWorkspace();
  const channel = ws.channels.find((c) => c.id === m.channel_id);
  const [state, setState] = useState<{ channelId: string; reads: Record<string, string | null> } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    messaging
      .readState(m.channel_id)
      .then((list: ReadState[]) => {
        if (!live) return;
        setState({ channelId: m.channel_id, reads: Object.fromEntries(list.map((r) => [r.user_id, r.last_read_at])) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [m.channel_id, attempt]);

  useWorkspaceEvents((e) => {
    const ev = asMessagingEvent(e);
    if (ev?.type === "channel.read" && ev.channel_id === m.channel_id) {
      setState((s) =>
        s && s.channelId === ev.channel_id ? { ...s, reads: { ...s.reads, [ev.user_id]: ev.last_read_at } } : s,
      );
    }
    if (e.type === "resync") setAttempt((n) => n + 1);
  });

  if (!channel || channel.kind !== "dm" || !state || state.channelId !== m.channel_id) return null;
  const others = channel.member_ids.filter((id) => id !== ws.me?.id);
  if (!others.length) return null;
  const sentAt = new Date(m.created_at).getTime();
  const seen = others.filter((id) => {
    const at = state.reads[id];
    return !!at && new Date(at).getTime() >= sentAt;
  });
  if (!seen.length) return null;

  const names = seen.map((id) => ws.memberById[id]?.full_name ?? "Someone");
  const label =
    others.length === 1 ? "Seen" : seen.length === others.length ? "Seen by everyone" : `Seen by ${seen.length}`;

  return (
    <div
      className="flex items-center justify-end gap-1 px-5 pt-0.5 pb-1 text-[11px] text-muted-foreground"
      title={`Seen by ${names.join(", ")}`}
      aria-live="polite"
    >
      <CheckCheck className="size-3.5 text-link" aria-hidden />
      <span>{label}</span>
      {others.length > 1 && (
        <span className="ml-0.5 flex -space-x-1">
          {seen.slice(0, 5).map((id) => (
            <UserAvatar key={id} id={id} name={ws.memberById[id]?.full_name ?? "?"} size="xs" className="ring-1 ring-background" />
          ))}
        </span>
      )}
    </div>
  );
}
