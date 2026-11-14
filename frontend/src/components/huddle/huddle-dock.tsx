"use client";

import {
  Ellipsis,
  Hand,
  Headphones,
  LoaderCircle,
  Maximize2,
  MonitorUp,
  Phone,
  PhoneOff,
  ScreenShareOff,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { openEffectsPanel } from "@/components/effects/panel-state";
import { useEffectsPrefs } from "@/components/effects/store";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { EffectsButton, MicButton, RoundButton, Tip, useScreenShare } from "./call-window/controls";
import { ReactionLayer } from "./call-window/reaction-layer";
import { useCallSignals } from "./call-window/signals";
import { CALL_POPOVER_CLASS, CALL_THEME_VARS } from "./call-window/theme";
import { useCallInfo } from "./call-window/use-call";
import { SpeakingBars } from "./huddle-button";
import { useHuddleRoom, useHuddles } from "./huddle-provider";
import { formatElapsed, useNow } from "./hooks";
import type { HuddleParticipantView } from "./types";

/** 32px controls in a narrow dock (36px otherwise). */
const NARROW_BTN = "@max-[16.5rem]:size-8 @max-[16.5rem]:[&_svg]:size-3.5";
/** Secondary controls: inline in a wide dock, in the "⋯" menu in a narrow one. */
const WIDE_ONLY = "hidden @min-[16.5rem]:inline-flex";

// --- Which docks are on screen right now (so <HuddleBar> can hide its floating pill) ---

const visibleDocks = new Set<symbol>();
const dockListeners = new Set<() => void>();
let dockVisible = false;

function setDockVisible(token: symbol, visible: boolean) {
  if (visible) visibleDocks.add(token);
  else visibleDocks.delete(token);
  const next = visibleDocks.size > 0;
  if (next === dockVisible) return;
  dockVisible = next;
  dockListeners.forEach((fn) => fn());
}

function subscribeDocks(fn: () => void) {
  dockListeners.add(fn);
  return () => {
    dockListeners.delete(fn);
  };
}

/** True while a <HuddleDock> is mounted and actually laid out (e.g. the desktop sidebar is showing). */
export function useHuddleDockVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocks,
    () => dockVisible,
    () => false,
  );
}

// --- Shared summary of the call I'm in ---

export function useHuddleSummary(channelId: string | null) {
  const { huddles, joinedAt, call: ctxCall, callKind } = useHuddles();
  const { channels, channelLabel } = useWorkspace();
  const { call } = useCallInfo();
  const channel = channelId ? channels.find((c) => c.id === channelId) : undefined;
  const title = channel ? (channel.kind === "dm" ? channelLabel(channel) : `#${channel.name}`) : "Huddle";
  const now = useNow();
  const startedAt = (call ?? ctxCall)?.started_at ?? (channelId ? huddles[channelId]?.started_at : null);
  const start = startedAt ? Date.parse(startedAt) : joinedAt;
  const elapsed = now && start ? formatElapsed(now - start) : "0:00";
  const kind = (call ?? ctxCall)?.kind ?? callKind;
  return { title, elapsed, kind, isCall: !!(call ?? ctxCall), channel };
}

/** Speakers first, then people with video, then everyone else. */
export function orderForAvatars(list: HuddleParticipantView[]) {
  return [...list].sort((a, b) => Number(b.speaking) - Number(a.speaking) || Number(!!b.cameraTrack) - Number(!!a.cameraTrack));
}

/**
 * Slack-style huddle widget for the BOTTOM of the sidebar: where you are, how long, who's
 * talking, and the essential controls. Renders nothing when I'm not in a call. While it's on
 * screen, <HuddleBar> hides its floating pill automatically.
 */
export function HuddleDock({ className }: { className?: string }) {
  const { activeChannelId } = useHuddles();
  if (!activeChannelId) return null;
  return <Dock key={activeChannelId} channelId={activeChannelId} className={className} />;
}

function Dock({ channelId, className }: { channelId: string; className?: string }) {
  const { status, room, toggleCamera, setExpanded, leave, startAudio, expanded } = useHuddles();
  const snap = useHuddleRoom();
  const signals = useCallSignals(room);
  const share = useScreenShare();
  const { effect } = useEffectsPrefs();
  const { title, elapsed, kind, isCall } = useHuddleSummary(channelId);
  const connecting = status === "connecting";
  const reconnecting = status === "reconnecting";
  const hands = Object.keys(signals.hands).length;
  const sharer = snap.participants.find((p) => p.screenTrack);

  // Register while actually laid out (a `display:none` ancestor gives a 0×0 box).
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const token = Symbol("huddle-dock");
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDockVisible(token, width > 0 && height > 0);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setDockVisible(token, false);
    };
  }, [el]);

  const people = orderForAvatars(snap.participants);
  const shown = people.slice(0, 4);
  const more = people.length - shown.length;
  const KindIcon = kind === "video" ? Video : isCall ? Phone : Headphones;

  return (
    <section
      ref={setEl}
      aria-label={`Call in ${title}`}
      className={cn(
        "dark @container relative mx-2 mb-2 min-w-0 overflow-hidden rounded-2xl bg-zinc-950/90 p-2.5 text-zinc-50 shadow-[0_18px_40px_-16px_rgb(0_0_0/0.7)] ring-1 ring-white/10 backdrop-blur-xl",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(260px_120px_at_0%_0%,rgb(16_185_129/0.16),transparent_70%)]"
      />

      {/* Title row: opens the call window */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        disabled={connecting}
        className="relative flex w-full items-center gap-2 rounded-xl px-1 py-0.5 text-left outline-none transition hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg ring-1",
            connecting || reconnecting
              ? "bg-amber-400/10 text-amber-300 ring-amber-300/20"
              : "bg-emerald-400/10 text-emerald-300 ring-emerald-300/20",
          )}
        >
          {connecting ? (
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : snap.speakingIds.length ? (
            <SpeakingBars className="h-3" />
          ) : (
            <KindIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight">{title}</span>
          <span className="flex items-center gap-1 text-[11.5px] text-white/55" aria-live="polite">
            {connecting ? (
              "Connecting…"
            ) : reconnecting ? (
              <span className="text-amber-300">Reconnecting…</span>
            ) : (
              <>
                <span className="tabular-nums">{elapsed}</span>
                <span aria-hidden>·</span>
                <span>
                  {snap.participants.length} {snap.participants.length === 1 ? "person" : "people"}
                </span>
              </>
            )}
          </span>
        </span>
        {hands > 0 && (
          <span
            className="inline-flex h-5 items-center gap-0.5 rounded-full bg-amber-400 px-1.5 text-[11px] font-bold text-amber-950"
            title={`${hands} raised ${hands === 1 ? "hand" : "hands"}`}
          >
            <Hand className="size-3" aria-hidden />
            {hands}
          </span>
        )}
        <Maximize2 className="size-3.5 shrink-0 text-white/40" aria-hidden />
      </button>

      {!snap.canPlayAudio && (
        <button
          type="button"
          onClick={() => void startAudio()}
          className="relative mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-400 px-2 py-1 text-[11.5px] font-semibold text-amber-950 outline-none hover:bg-amber-300 focus-visible:ring-2 focus-visible:ring-amber-200/70"
        >
          <Volume2 className="size-3.5" aria-hidden />
          Click to hear the call
        </button>
      )}

      {/* Who's here */}
      {!connecting && (
        <div className="relative mt-2 flex min-w-0 items-center gap-2 px-1">
          {/* 4 faces, 3 in a narrow dock (the "+N" adjusts), so the row never overflows. */}
          <ul aria-label="Participants" className="flex shrink-0 items-center -space-x-1.5 @max-[16.5rem]:[&>li:nth-child(n+4)]:hidden">
            {shown.map((p) => (
              <DockAvatar key={p.identity} p={p} />
            ))}
          </ul>
          {more > 0 && (
            <span aria-hidden className="shrink-0 text-[11.5px] font-semibold text-white/60 tabular-nums @max-[16.5rem]:hidden">
              +{more}
            </span>
          )}
          {shown.length > 3 && (
            <span aria-hidden className="hidden shrink-0 text-[11.5px] font-semibold text-white/60 tabular-nums @max-[16.5rem]:inline">
              +{more + shown.length - 3}
            </span>
          )}
          {sharer && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="ml-auto inline-flex min-w-0 items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300 outline-none ring-1 ring-emerald-300/20 hover:bg-emerald-400/25 focus-visible:ring-2 focus-visible:ring-emerald-200/70"
            >
              <MonitorUp className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{sharer.isLocal ? "Presenting" : "View screen"}</span>
            </button>
          )}
        </div>
      )}

      {/* Controls. Two layouts by the dock's own width (container query):
          - narrow (< 16.5rem inside, i.e. sidebar under ~300px): mic · camera · "⋯" · Leave, 32px buttons;
          - wide: mic · camera · effects · share · open window · Leave, 36px buttons.
          Nothing wraps or clips anywhere from a 200px to a 440px sidebar. */}
      <div role="toolbar" aria-label="Call controls" className="relative mt-2.5 flex min-w-0 items-center gap-1.5">
        <MicButton snap={snap} room={room} tone="stage" size="sm" disabled={connecting} className={NARROW_BTN} />
        <Tip
          label={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
          trigger={
            <RoundButton
              tone="stage"
              size="sm"
              state={snap.cameraEnabled ? "default" : "off"}
              label={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
              aria-pressed={snap.cameraEnabled}
              disabled={connecting}
              onClick={() => void toggleCamera()}
              className={cn(NARROW_BTN, !snap.cameraEnabled && "bg-white/[0.08] text-white/80 ring-white/10 hover:bg-white/15")}
            />
          }
        >
          {snap.cameraEnabled ? <Video aria-hidden /> : <VideoOff aria-hidden />}
        </Tip>
        <EffectsButton tone="stage" size="sm" className={WIDE_ONLY} />
        {share.supported && (
          <Tip
            label={snap.screenShareEnabled ? "Stop sharing" : "Share screen"}
            trigger={
              <RoundButton
                tone="stage"
                size="sm"
                state={snap.screenShareEnabled ? "live" : "default"}
                label={snap.screenShareEnabled ? "Stop sharing screen" : "Share screen"}
                aria-pressed={snap.screenShareEnabled}
                disabled={connecting}
                onClick={() => void (snap.screenShareEnabled ? share.toggle() : share.start(false))}
                className={WIDE_ONLY}
              />
            }
          >
            {snap.screenShareEnabled ? <ScreenShareOff aria-hidden /> : <MonitorUp aria-hidden />}
          </Tip>
        )}
        <Tip
          label="Open call window"
          trigger={
            <RoundButton
              tone="stage"
              size="sm"
              label="Open call window"
              disabled={connecting}
              onClick={() => setExpanded(true)}
              className={WIDE_ONLY}
            />
          }
        >
          <Maximize2 aria-hidden />
        </Tip>

        {/* Narrow docks: the secondary actions live here instead. */}
        <DropdownMenu>
          <Tip
            label="More options"
            trigger={
              <DropdownMenuTrigger
                disabled={connecting}
                render={
                  <RoundButton
                    tone="stage"
                    size="sm"
                    label="More call options"
                    className={cn(NARROW_BTN, "@min-[16.5rem]:hidden", snap.screenShareEnabled && "ring-2 ring-emerald-400/70")}
                  />
                }
              />
            }
          >
            <Ellipsis aria-hidden />
          </Tip>
          <DropdownMenuContent side="top" align="start" sideOffset={8} className={cn("w-56", CALL_POPOVER_CLASS)} style={CALL_THEME_VARS}>
            <DropdownMenuItem onClick={openEffectsPanel} className="min-h-9 gap-2">
              <Sparkles className="text-fuchsia-300" aria-hidden />
              Backgrounds &amp; effects
              {effect !== "none" && (
                <span className="ml-auto inline-flex items-center">
                  <span aria-hidden className="size-2 rounded-full bg-fuchsia-400" />
                  <span className="sr-only">(on)</span>
                </span>
              )}
            </DropdownMenuItem>
            {share.supported && (
              <DropdownMenuItem
                onClick={() => void (snap.screenShareEnabled ? share.toggle() : share.start(false))}
                className="min-h-9 gap-2"
              >
                {snap.screenShareEnabled ? <ScreenShareOff className="text-emerald-300" aria-hidden /> : <MonitorUp aria-hidden />}
                {snap.screenShareEnabled ? "Stop sharing screen" : "Share screen"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setExpanded(true)} className="min-h-9 gap-2">
              <Maximize2 aria-hidden />
              Open call window
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tip
          label="Leave call"
          trigger={
            <button
              type="button"
              onClick={leave}
              aria-label="Leave call"
              className="ml-auto inline-flex h-9 min-w-10 shrink-0 items-center justify-center rounded-full bg-red-600 px-3 text-white outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-200/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 @max-[16.5rem]:h-8 @max-[16.5rem]:min-w-9 @max-[16.5rem]:px-2.5 [&_svg]:size-4"
            />
          }
        >
          <PhoneOff aria-hidden />
        </Tip>
      </div>
      {!expanded && <ReactionLayer reactions={signals.reactions} size="sm" />}
    </section>
  );
}

function DockAvatar({ p }: { p: HuddleParticipantView }) {
  const { memberById } = useWorkspace();
  const name = memberById[p.identity]?.full_name ?? p.name;
  return (
    <li
      title={`${name}${p.isLocal ? " (you)" : ""}${p.micEnabled ? "" : " · muted"}`}
      className={cn(
        "relative rounded-[9px] ring-2 transition-[--tw-ring-color,box-shadow] duration-150",
        p.speaking ? "z-10 ring-emerald-400 shadow-[0_0_0_4px_rgb(52_211_153/0.2)]" : "ring-zinc-950",
      )}
    >
      <UserAvatar id={p.identity} name={name} size="md" />
      <span className="sr-only">
        {name}
        {p.speaking ? ", speaking" : ""}
        {p.micEnabled ? "" : ", muted"}
      </span>
    </li>
  );
}
