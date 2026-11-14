import type { Message, RealtimeEvent } from "@/lib/api";

/**
 * Apply a realtime event to a list of messages that all share the same parent
 * (`parentId` null = channel timeline, otherwise a thread). Returns the same array if nothing changed.
 */
export function applyMessageEvent(
  list: Message[],
  e: RealtimeEvent,
  scope: { channelId: string; parentId: string | null },
): Message[] {
  if (!("channel_id" in e) && !("message" in e)) return list;
  const channelId = "message" in e ? e.message.channel_id : e.channel_id;
  if (channelId !== scope.channelId) return list;

  switch (e.type) {
    case "message.created": {
      const m = e.message;
      if (m.parent_id === scope.parentId) {
        return list.some((x) => x.id === m.id) ? list : [...list, m];
      }
      // A reply to a message in this list: bump its thread counter.
      return list.map((x) =>
        x.id === m.parent_id ? { ...x, reply_count: x.reply_count + 1, last_reply_at: m.created_at } : x,
      );
    }
    case "message.updated":
      return list.map((x) => (x.id === e.message.id ? mergeUpdate(x, e.message) : x));
    case "message.deleted":
      if (e.parent_id && e.parent_id !== scope.parentId) {
        return list.map((x) => (x.id === e.parent_id ? { ...x, reply_count: Math.max(0, x.reply_count - 1) } : x));
      }
      return list.filter((x) => x.id !== e.message_id);
    case "reaction.updated":
      return list.map((x) => (x.id === e.message_id ? { ...x, reactions: e.reactions } : x));
    default:
      return list;
  }
}

type PerViewer = { saved?: boolean; poll?: { my_votes?: string[] | null } | null };

/**
 * Apply a broadcast `message.updated` on top of what we have. Broadcasts can't carry
 * per-viewer state, so keep ours: the thread counter, "saved for later" and my poll votes.
 */
export function mergeUpdate(prev: Message, next: Message): Message {
  const p = prev as Message & PerViewer;
  const n = next as Message & PerViewer;
  const merged: Message & PerViewer = { ...n, reply_count: prev.reply_count };
  if (p.saved !== undefined) merged.saved = p.saved;
  if (n.poll && p.poll?.my_votes?.length && !n.poll.my_votes?.length) {
    merged.poll = { ...n.poll, my_votes: p.poll.my_votes };
  }
  return merged;
}

export function upsert(list: Message[], m: Message): Message[] {
  return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * In-app link to a message: opens its channel, scrolls to it and highlights it.
 * Thread replies point at their parent and also open the thread (`thread=`).
 */
export function messagePath(m: Pick<Message, "id" | "workspace_id" | "channel_id" | "parent_id">): string {
  const params = new URLSearchParams({ msg: m.parent_id ?? m.id });
  if (m.parent_id) {
    params.set("thread", m.parent_id);
    params.set("reply", m.id);
  }
  return `/w/${m.workspace_id}/c/${m.channel_id}?${params}`;
}

/** Media-query helpers for client event handlers (never call during render). */
export const media = {
  /** Touch-first device with no hover (phones, most tablets). */
  noHover: () => typeof window !== "undefined" && window.matchMedia("(hover: none)").matches,
  /** Mouse/trackpad: safe to autofocus inputs without popping a virtual keyboard. */
  finePointer: () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches,
  /** Below the `lg` breakpoint, side panels render as overlays. */
  overlayPanels: () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
};
