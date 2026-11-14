"use client";

import { GripVertical, Headphones, LoaderCircle, Maximize2, MonitorUp, Phone, PhoneOff, Video, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { CallWindow } from "./call-window/call-window";
import { EffectsDialogHost } from "./effects-host";
import { MicButton, Tip } from "./call-window/controls";
import { ReactionLayer } from "./call-window/reaction-layer";
import { useCallSignals } from "./call-window/signals";
import { SpeakingBars } from "./huddle-button";
import { orderForAvatars, useHuddleDockVisible, useHuddleSummary } from "./huddle-dock";
import { useHuddleRoom, useHuddles } from "./huddle-provider";
import type { HuddleParticipantView } from "./types";

/**
 * Hosts the call while I'm in one: the full call window, plus a compact floating pill.
 *
 * The pill is only for when there's no <HuddleDock> on screen, i.e. on phones (below `md`)
 * or when the sidebar is hidden (focus mode). With `floating="auto"` (default) that's detected
 * automatically: the pill hides itself whenever a HuddleDock is laid out. `"always"` / `"never"`
 * force it. Mount once inside <HuddleProvider>, anywhere in the workspace shell.
 */
export function HuddleBar({ floating = "auto" }: { floating?: "auto" | "always" | "never" }) {
  const { activeChannelId } = useHuddles();
  if (!activeChannelId) return null;
  return <HuddleHost key={activeChannelId} channelId={activeChannelId} floating={floating} />;
}

function HuddleHost({ channelId, floating }: { channelId: string; floating: "auto" | "always" | "never" }) {
  const { expanded, setExpanded, call } = useHuddles();
  const dockVisible = useHuddleDockVisible();
  const summary = useHuddleSummary(channelId);

  // Video calls open straight into the big window, until the user minimises it once.
  const [autoDismissed, setAutoDismissed] = useState(false);
  const windowOpen = expanded || (call?.kind === "video" && !autoDismissed);
  const minimize = () => {
    setAutoDismissed(true);
    setExpanded(false);
  };

  const showPill = floating === "always" || (floating === "auto" && !dockVisible);

  return (
    <>
      {showPill && <Pill channelId={channelId} hidden={windowOpen} onExpand={() => setExpanded(true)} />}
      <CallWindow channelId={channelId} open={windowOpen} onMinimize={minimize} elapsed={summary.elapsed} />
      {!windowOpen && <EffectsDialogHost />}
    </>
  );
}

const PILL_POS_KEY = "worklio.huddlePill";

function readOffset(): { x: number; y: number } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PILL_POS_KEY) ?? "null") as { x?: unknown; y?: unknown } | null;
    if (raw && typeof raw.x === "number" && typeof raw.y === "number") return { x: raw.x, y: raw.y };
  } catch {
    // ignore
  }
  return { x: 0, y: 0 };
}

/**
 * Compact floating pill: who's talking, timer, mute, open, leave. Sits top-right under the
 * channel header (never over the composer) and can be dragged anywhere.
 */
function Pill({ channelId, hidden, onExpand }: { channelId: string; hidden: boolean; onExpand: () => void }) {
  const { status, leave, room, startAudio } = useHuddles();
  const snap = useHuddleRoom();
  const signals = useCallSignals(room);
  const { title, elapsed, kind, isCall } = useHuddleSummary(channelId);
  const connecting = status === "connecting";
  const reconnecting = status === "reconnecting";
  const sharer = snap.participants.find((p) => p.screenTrack);
  const people = orderForAvatars(snap.participants).slice(0, 3);
  const KindIcon = kind === "video" ? Video : isCall ? Phone : Headphones;

  // --- Drag ---
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; rect: DOMRect; moved: boolean } | null>(null);
  const [offset, setOffset] = useState(readOffset);

  useEffect(() => {
    const reset = () => setOffset({ x: 0, y: 0 });
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !boxRef.current) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y, rect: boxRef.current.getBoundingClientRect(), moved: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const m = 8;
    const left = clamp(d.rect.left + e.clientX - d.x, m, window.innerWidth - d.rect.width - m);
    const top = clamp(d.rect.top + e.clientY - d.y, m, window.innerHeight - d.rect.height - m);
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    setOffset({ x: d.ox + left - d.rect.left, y: d.oy + top - d.rect.top });
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      onExpand();
      return;
    }
    try {
      sessionStorage.setItem(PILL_POS_KEY, JSON.stringify(offset));
    } catch {
      // ignore
    }
  }

  const label = connecting ? "Connecting…" : reconnecting ? "Reconnecting…" : elapsed;

  return (
    <div
      ref={boxRef}
      role="region"
      aria-label={`Call in ${title}`}
      aria-hidden={hidden || undefined}
      inert={hidden}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
      className={cn(
        "dark fixed top-[calc(env(safe-area-inset-top)+6.5rem)] right-3 z-40 flex max-w-[calc(100vw-24px)] cursor-grab touch-none items-center gap-2 rounded-full bg-zinc-950/90 py-1.5 pr-1.5 pl-2 text-zinc-50 shadow-[0_18px_44px_-14px_rgb(0_0_0/0.75)] ring-1 ring-white/10 backdrop-blur-xl select-none active:cursor-grabbing",
        "transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none",
        hidden ? "pointer-events-none scale-95 opacity-0" : "animate-in fade-in-0 slide-in-from-top-2 duration-300 motion-reduce:animate-none",
      )}
    >
      <GripVertical className="hidden size-3.5 shrink-0 text-white/30 sm:block" aria-hidden />
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          connecting || reconnecting ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300",
        )}
      >
        {connecting ? (
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : snap.speakingIds.length ? (
          <SpeakingBars className="h-2.5" />
        ) : (
          <KindIcon className="size-3.5" />
        )}
      </span>

      {people.length > 0 && (
        <span className="hidden items-center -space-x-1.5 min-[400px]:flex" aria-hidden>
          {people.map((p) => (
            <PillAvatar key={p.identity} p={p} />
          ))}
        </span>
      )}

      <span className="min-w-0 max-w-[9rem] sm:max-w-[12rem]">
        <span className="block truncate text-[12.5px] leading-tight font-semibold">{title}</span>
        <span className={cn("block text-[11px] leading-tight tabular-nums", reconnecting || connecting ? "text-amber-300" : "text-white/55")} aria-live="polite">
          {label}
        </span>
      </span>

      {!snap.canPlayAudio && (
        <button
          type="button"
          onClick={() => void startAudio()}
          aria-label="Your browser paused call audio. Click to listen."
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-400 text-amber-950 outline-none hover:bg-amber-300 focus-visible:ring-2 focus-visible:ring-amber-200/70"
        >
          <Volume2 className="size-4" aria-hidden />
        </button>
      )}

      {sharer && (
        <Tip
          label={sharer.isLocal ? "You're presenting" : "View the shared screen"}
          side="bottom"
          trigger={
            <button
              type="button"
              onClick={onExpand}
              aria-label={sharer.isLocal ? "You're presenting. Open the call" : "View the shared screen"}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300 outline-none ring-1 ring-emerald-300/25 hover:bg-emerald-400/25 focus-visible:ring-2 focus-visible:ring-emerald-200/70"
            />
          }
        >
          <MonitorUp className="size-4" aria-hidden />
        </Tip>
      )}

      <MicButton snap={snap} room={room} tone="stage" size="sm" disabled={connecting} />
      <Tip
        label="Open call window"
        side="bottom"
        trigger={
          <button
            type="button"
            onClick={onExpand}
            disabled={connecting}
            aria-label="Open call window"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white outline-none ring-1 ring-white/10 transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          />
        }
      >
        <Maximize2 className="size-4" aria-hidden />
      </Tip>
      <Tip
        label="Leave call"
        side="bottom"
        trigger={
          <button
            type="button"
            onClick={leave}
            aria-label="Leave call"
            className="flex h-9 w-11 shrink-0 items-center justify-center rounded-full bg-red-600 text-white outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-200/70 active:scale-95 motion-reduce:active:scale-100"
          />
        }
      >
        <PhoneOff className="size-4" aria-hidden />
      </Tip>

      {!hidden && <ReactionLayer reactions={signals.reactions} size="sm" className="inset-auto top-full right-0 left-0 h-36" />}
    </div>
  );
}

function PillAvatar({ p }: { p: HuddleParticipantView }) {
  const { memberById } = useWorkspace();
  const name = memberById[p.identity]?.full_name ?? p.name;
  return (
    <span
      className={cn(
        "relative rounded-[7px] ring-2 transition-[--tw-ring-color] duration-150",
        p.speaking ? "z-10 ring-emerald-400" : "ring-zinc-950",
      )}
    >
      <UserAvatar id={p.identity} name={name} size="sm" className="[&>span]:size-6 [&>span]:rounded-[6px] [&>span]:text-[10px]" />
    </span>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
