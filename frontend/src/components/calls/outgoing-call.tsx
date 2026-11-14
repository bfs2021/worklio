"use client";

import { PhoneMissed, PhoneOff, Video, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useHuddles } from "@/components/huddle/huddle-provider";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import {
  AnimatedDots,
  CallStyles,
  channelContext,
  firstName,
  joinNames,
  ringingInvites,
  useIsClient,
  useTimedOut,
} from "./call-styles";
import type { CallOut } from "./types";

const OUTCOME_MS = 2800;

/**
 * Caller-side overlay: "Calling Bob…" while my invites ring and nobody else has joined,
 * a compact "Ringing Bob" pill once others are in, and a short-lived outcome
 * ("No answer" / "Declined") when the call ends unanswered.
 */
export function OutgoingCall() {
  const { call, endedCall, clearEndedCall } = useHuddles();
  const { me } = useWorkspace();
  const client = useIsClient();

  useEffect(() => {
    if (!endedCall) return;
    const id = window.setTimeout(clearEndedCall, Math.max(0, endedCall.at + OUTCOME_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [endedCall, clearEndedCall]);

  const ringing = call && me ? ringingInvites(call.invites, me.id) : [];
  const ringKey = call ? `${call.id}:${ringing.map((i) => i.user_id).join(",")}` : null;
  // If the server's ring timeout never reaches us (lost event, sleeping laptop), don't keep
  // showing "Calling…" forever: offer to hang up instead.
  const timedOut = useTimedOut(ringKey, ringing.length > 0);

  if (!client || !me) return null;

  let content: React.ReactNode = null;
  if (call && ringing.length && timedOut) {
    const alone = !call.joined_ids.some((id) => id !== me.id) && !call.participant_ids.some((id) => id !== me.id);
    content = alone ? <NoAnswerBanner key={`${call.id}-noanswer`} ringingIds={ringing.map((i) => i.user_id)} /> : null;
  } else if (call && ringing.length) {
    const alone = !call.joined_ids.some((id) => id !== me.id) && !call.participant_ids.some((id) => id !== me.id);
    content = alone ? (
      <CallingBanner key={call.id} call={call} ringingIds={ringing.map((i) => i.user_id)} />
    ) : (
      <RingingPill key={`${call.id}-pill`} ringingIds={ringing.map((i) => i.user_id)} />
    );
  } else if (endedCall && !call) {
    content = <OutcomeBanner key={endedCall.at} call={endedCall.call} onClose={clearEndedCall} />;
  }
  if (!content) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[150] flex justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <CallStyles />
      {content}
    </div>,
    document.body,
  );
}

function useNames(ids: string[]) {
  const { memberById } = useWorkspace();
  return ids.map((id) => firstName(memberById[id]?.full_name));
}

/** Run an async action once at a time; the button stays usable again if it fails. */
function useBusy(): [boolean, (fn: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  return [busy, run];
}

function CallingBanner({ call, ringingIds }: { call: CallOut; ringingIds: string[] }) {
  const { cancelRinging, status } = useHuddles();
  const [busy, run] = useBusy();
  const { memberById, channels } = useWorkspace();
  const names = useNames(ringingIds);
  const channel = channels.find((c) => c.id === call.channel_id);
  const isVideo = call.kind === "video";
  const shown = ringingIds.slice(0, 3);
  const where = channel && channel.kind !== "dm" ? channelContext(channel) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      className="wk-call-drop pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-2xl bg-popover/95 p-3 pr-3 text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl supports-backdrop-filter:bg-popover/80"
    >
      <div className="relative grid size-11 shrink-0 place-items-center">
        <div className="wk-call-rings absolute inset-0 grid place-items-center" aria-hidden>
          <span className="absolute size-10 rounded-xl bg-emerald-500/40" />
          <span className="absolute size-10 rounded-xl bg-emerald-500/40" />
        </div>
        {shown.length > 1 ? (
          <span className="relative flex -space-x-3">
            {shown.slice(0, 2).map((id) => (
              <UserAvatar
                key={id}
                id={id}
                name={memberById[id]?.full_name ?? "?"}
                size="md"
                className="rounded-md ring-2 ring-popover"
              />
            ))}
          </span>
        ) : (
          <UserAvatar id={ringingIds[0]} name={memberById[ringingIds[0]]?.full_name ?? "?"} size="lg" className="relative" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">
          Calling {joinNames(names)}
          <AnimatedDots />
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          {isVideo && <Video className="size-3.5 shrink-0" aria-hidden />}
          <span className="truncate">
            {status === "connecting" ? "Connecting" : "Ringing"}
            {isVideo ? " · Video call" : " · Audio call"}
            {where ? ` · ${where}` : ""}
          </span>
        </p>
      </div>

      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => run(cancelRinging)}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-red-500 px-3.5 text-sm font-medium text-white shadow-sm shadow-red-500/30 transition-[background-color,transform] hover:bg-red-600 focus-visible:ring-4 focus-visible:ring-red-500/40 focus-visible:outline-none active:scale-95 disabled:opacity-70"
      >
        <PhoneOff className="size-4" aria-hidden />
        Cancel
      </button>
    </div>
  );
}

function NoAnswerBanner({ ringingIds }: { ringingIds: string[] }) {
  const { cancelRinging, leave } = useHuddles();
  const names = useNames(ringingIds);
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      aria-live="polite"
      className="wk-call-drop pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-2xl bg-popover/95 p-3 text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground" aria-hidden>
        <PhoneMissed className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">No answer</p>
        <p className="truncate text-xs text-muted-foreground">{joinNames(names) || "They"} didn&apos;t pick up.</p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await cancelRinging();
          } finally {
            // cancelRinging leaves when alone; make sure we never stay stuck in an empty call.
            leave();
            setBusy(false);
          }
        }}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-red-500 px-3.5 text-sm font-medium text-white shadow-sm shadow-red-500/30 transition-[background-color,transform] hover:bg-red-600 focus-visible:ring-4 focus-visible:ring-red-500/40 focus-visible:outline-none active:scale-95 disabled:opacity-70"
      >
        <PhoneOff className="size-4" aria-hidden />
        Hang up
      </button>
    </div>
  );
}

function RingingPill({ ringingIds }: { ringingIds: string[] }) {
  const { cancelRinging } = useHuddles();
  const [busy, run] = useBusy();
  const names = useNames(ringingIds);
  return (
    <div
      role="status"
      aria-live="polite"
      className="wk-call-drop pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-popover/95 py-1 pr-1 pl-3 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10 backdrop-blur-xl"
    >
      <span className="wk-call-live size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <span className="truncate">
        Ringing {joinNames(names)}
        <AnimatedDots />
      </span>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => run(cancelRinging)}
        className="inline-flex h-8 shrink-0 items-center rounded-full px-2.5 font-medium text-red-600 transition-colors hover:bg-red-500/10 focus-visible:ring-3 focus-visible:ring-red-500/30 focus-visible:outline-none disabled:opacity-60 dark:text-red-400"
      >
        Stop ringing
      </button>
    </div>
  );
}

function OutcomeBanner({ call, onClose }: { call: CallOut; onClose: () => void }) {
  const { memberById } = useWorkspace();
  const invited = call.invites.map((i) => i.user_id);
  const names = invited.map((id) => firstName(memberById[id]?.full_name));
  const who = joinNames(names);
  const title =
    call.status === "declined"
      ? `${who || "They"} declined`
      : call.status === "missed"
        ? "No answer"
        : call.status === "cancelled"
          ? "Call cancelled"
          : "Call ended";
  const subtitle =
    call.status === "missed"
      ? `${who || "They"} didn't pick up. Try again later or send a message.`
      : call.status === "declined"
        ? "They can't talk right now."
        : "";
  const tone = call.status === "missed" || call.status === "declined" ? "red" : "neutral";

  return (
    <div
      role="status"
      aria-live="assertive"
      className="wk-call-drop pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-2xl bg-popover/95 p-3 text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl"
    >
      <span
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-xl",
          tone === "red" ? "bg-red-500/12 text-red-600 dark:text-red-400" : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        <PhoneMissed className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold">{title}</p>
        {subtitle && <p className="line-clamp-2 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
