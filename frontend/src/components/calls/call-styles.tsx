"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { Channel, Member } from "@/lib/api";

import type { CallInvite } from "./types";

const CSS = `
@keyframes wk-call-pulse { 0% { transform: scale(1); opacity: .5 } 80%,100% { transform: scale(1.85); opacity: 0 } }
.wk-call-rings > span { animation: wk-call-pulse 2.4s cubic-bezier(.2,.6,.35,1) infinite; }
.wk-call-rings > span:nth-child(2) { animation-delay: .8s }
.wk-call-rings > span:nth-child(3) { animation-delay: 1.6s }

@keyframes wk-call-in { from { opacity: 0; transform: translateY(14px) scale(.97) } to { opacity: 1; transform: none } }
.wk-call-in { animation: wk-call-in .32s cubic-bezier(.2,.8,.2,1) both }
@keyframes wk-call-drop { from { opacity: 0; transform: translateY(-12px) scale(.98) } to { opacity: 1; transform: none } }
.wk-call-drop { animation: wk-call-drop .28s cubic-bezier(.2,.8,.2,1) both }
@keyframes wk-call-fade { from { opacity: 0 } to { opacity: 1 } }
.wk-call-fade { animation: wk-call-fade .25s ease-out both }

@keyframes wk-call-wiggle { 0%,60%,100% { transform: rotate(0) } 10%,30%,50% { transform: rotate(-14deg) } 20%,40% { transform: rotate(14deg) } }
.wk-call-wiggle { animation: wk-call-wiggle 1.6s ease-in-out infinite; transform-origin: 50% 60% }

@keyframes wk-call-dot { 0%,80%,100% { opacity: .2 } 40% { opacity: 1 } }
.wk-call-dots > span { animation: wk-call-dot 1.2s infinite both }
.wk-call-dots > span:nth-child(2) { animation-delay: .15s }
.wk-call-dots > span:nth-child(3) { animation-delay: .3s }

@keyframes wk-call-live { 0%,100% { box-shadow: 0 0 0 0 rgb(16 185 129 / .45) } 50% { box-shadow: 0 0 0 6px rgb(16 185 129 / 0) } }
.wk-call-live { animation: wk-call-live 2s ease-in-out infinite }

@media (prefers-reduced-motion: reduce) {
  .wk-call-rings > span, .wk-call-wiggle, .wk-call-dots > span, .wk-call-live { animation: none !important }
  .wk-call-rings > span { opacity: 0 }
  .wk-call-in, .wk-call-drop, .wk-call-fade { animation-duration: .01ms !important }
}
@keyframes wk-call-blink { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.wk-call-blink { animation: wk-call-blink 1.6s ease-in-out infinite }
@media (prefers-reduced-motion: reduce) { .wk-call-blink { animation: none !important } }
[data-reduce-motion] .wk-call-rings > span { opacity: 0 }
[data-reduce-motion] .wk-call-dots > span { opacity: 1 }
`;

/** Keyframes shared by the call UI. React hoists and dedupes it by `href`. */
export function CallStyles() {
  return (
    <style href="worklio-calls" precedence="default">
      {CSS}
    </style>
  );
}

/** "…" that animates (static under reduced motion). */
export function AnimatedDots() {
  return (
    <span className="wk-call-dots inline-flex" aria-hidden>
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

// --- helpers ---

const noopSubscribe = () => () => {};
/** False during SSR / hydration, true on the client (for portals). */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function firstName(name: string | undefined | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "Someone";
}

/** "Bob" · "Bob and Carol" · "Bob, Carol and 2 others" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** "45 sec" · "12 min" · "1 hr 5 min" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Where a call happens, for subtitles: "Direct message" · "Group DM" · "#design". */
export function channelContext(channel: Channel | undefined): string {
  if (!channel) return "";
  if (channel.kind === "dm") return channel.member_ids.length > 2 ? "Group DM" : "Direct message";
  return `#${channel.name}`;
}

export function ringingInvites(invites: CallInvite[], invitedBy?: string): CallInvite[] {
  return invites.filter((i) => i.status === "ringing" && (!invitedBy || i.invited_by === invitedBy));
}

export function nameOf(memberById: Record<string, Member>, id: string, meId?: string, meName?: string): string {
  if (id === meId && meName) return meName;
  return memberById[id]?.full_name ?? "Someone";
}

/** A DM whose only member is me ("Alice (you)"): no calls there. */
export function isSelfDM(channel: Pick<Channel, "kind" | "member_ids"> | undefined, meId: string | undefined): boolean {
  if (!channel || channel.kind !== "dm" || !meId) return false;
  return channel.member_ids.length > 0 && channel.member_ids.every((id) => id === meId);
}

/** Server rings for 40 s; after this long locally we stop trusting a "still ringing" state. */
export const RING_GIVE_UP_MS = 50_000;

/**
 * True once `key` has been continuously `active` for `ms`. Resets when the key changes or
 * `active` goes false. A safety net so ring-back UI never sticks if a realtime event is lost.
 */
export function useTimedOut(key: string | null, active: boolean, ms: number = RING_GIVE_UP_MS): boolean {
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key || !active) return;
    const id = window.setTimeout(() => setExpiredKey(key), ms);
    return () => window.clearTimeout(id);
  }, [key, active, ms]);
  return !!key && active && expiredKey === key;
}
