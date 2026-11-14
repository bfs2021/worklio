"use client";

import { Bell, BellOff, Hash, Lock, MessageCircle, Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { hueFor, UserAvatar } from "@/components/chat/user-avatar";
import { useHuddles } from "@/components/huddle/huddle-provider";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { type IncomingRing, useCalls } from "./call-provider";
import { AnimatedDots, CallStyles, channelContext, useIsClient } from "./call-styles";

/**
 * Incoming call sheet: full screen on phones, a centred card on desktop. Portaled above
 * everything, focus-trapped. Enter accepts, Esc declines. Further rings queue behind it.
 */
export function IncomingCall() {
  const { incoming } = useCalls();
  const client = useIsClient();
  if (!client || !incoming.length) return null;
  const [top, ...queued] = incoming;
  return createPortal(<IncomingCallSheet key={top.call.id} ring={top} queued={queued} />, document.body);
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function IncomingCallSheet({ ring, queued }: { ring: IncomingRing; queued: IncomingRing[] }) {
  const { accept, decline, soundsMuted, setSoundsMuted } = useCalls();
  const { activeChannelId } = useHuddles();
  const { memberById, channels, channelLabel } = useWorkspace();
  const titleId = useId();
  const descId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);

  const { call, caller_id } = ring;
  const isVideo = call.kind === "video";
  const callerName = memberById[caller_id]?.full_name ?? "Someone";
  const channel = channels.find((c) => c.id === call.channel_id);
  const isDM = channel?.kind === "dm";
  const groupLabel = channel && isDM && channel.member_ids.length > 2 ? channelLabel(channel) : null;
  const context = channelContext(channel);
  const inAnotherCall = !!activeChannelId && activeChannelId !== call.channel_id;
  const kindLabel = isVideo ? "Video call" : isDM ? "Audio call" : "Huddle";

  // Latest handlers for the document-level key listener.
  const handlers = useRef({ onAccept: () => {}, onDecline: () => {} });
  useEffect(() => {
    handlers.current = {
      onAccept: () => void accept(call.id, isVideo),
      onDecline: () => void decline(call.id),
    };
  });

  // Focus management + keyboard: Enter accepts, Esc declines, Tab stays inside.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    acceptRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onDecline();
        return;
      }
      if (e.key === "Enter" && !e.isComposing) {
        // A focused button inside the card handles Enter itself.
        if (e.target instanceof HTMLElement && card.contains(e.target) && e.target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        handlers.current.onAccept();
        return;
      }
      if (e.key === "Tab") {
        const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!card.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  const ContextIcon = isDM ? MessageCircle : channel?.kind === "private" ? Lock : Hash;

  return (
    <div className="fixed inset-0 z-[200] flex items-stretch justify-center overscroll-none sm:items-center sm:p-6">
      <CallStyles />
      <div className="wk-call-fade absolute inset-0 bg-black/45 backdrop-blur-md" aria-hidden />

      <div className="relative flex h-full w-full sm:h-auto sm:w-[400px]">
        {/* Queued calls peek out behind the card. */}
        {queued.slice(0, 2).map((q, i) => (
          <div
            key={q.call.id}
            aria-hidden
            className="absolute inset-x-6 hidden h-full rounded-[28px] bg-popover/70 shadow-lg ring-1 ring-foreground/10 sm:block"
            style={{ transform: `translateY(${(i + 1) * 10}px) scale(${1 - (i + 1) * 0.04})`, zIndex: -1 - i }}
          />
        ))}

        <div
          ref={cardRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          className="wk-call-in relative flex max-h-dvh w-full flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10 sm:rounded-[28px]"
          style={{ "--call-h": hueFor(caller_id) } as React.CSSProperties}
        >
          {/* Caller-tinted wash */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-[radial-gradient(120%_80%_at_50%_0%,hsl(var(--call-h)_75%_60%/0.28),transparent_70%)] dark:bg-[radial-gradient(120%_80%_at_50%_0%,hsl(var(--call-h)_70%_45%/0.35),transparent_70%)]"
          />

          <div className="relative flex items-center justify-between px-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:pt-5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.06] px-2.5 py-1 text-xs font-medium text-muted-foreground dark:bg-white/10">
              {isVideo ? <Video className="size-3.5" aria-hidden /> : <Phone className="size-3.5" aria-hidden />}
              Incoming {kindLabel.toLowerCase()}
            </span>
            <button
              type="button"
              onClick={() => setSoundsMuted(!soundsMuted)}
              aria-pressed={soundsMuted}
              aria-label={soundsMuted ? "Unmute ringtone" : "Mute ringtone"}
              title={soundsMuted ? "Unmute ringtone" : "Mute ringtone"}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:hover:bg-white/10"
            >
              {soundsMuted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            </button>
          </div>

          <div className="relative flex flex-1 flex-col items-center justify-center px-6 pt-6 pb-4 text-center sm:flex-none sm:pt-4">
            <div className="relative grid size-28 place-items-center">
              <div className="wk-call-rings absolute inset-0 grid place-items-center" aria-hidden>
                <span className="absolute size-20 rounded-[22px] bg-[hsl(var(--call-h)_70%_55%/0.45)]" />
                <span className="absolute size-20 rounded-[22px] bg-[hsl(var(--call-h)_70%_55%/0.45)]" />
                <span className="absolute size-20 rounded-[22px] bg-[hsl(var(--call-h)_70%_55%/0.45)]" />
              </div>
              <UserAvatar
                id={caller_id}
                name={callerName}
                size="xl"
                className="relative scale-125 shadow-lg [&>span]:rounded-[18px]"
              />
            </div>

            <h2 id={titleId} className="mt-6 max-w-full truncate text-2xl font-semibold tracking-tight">
              {callerName}
            </h2>
            <p id={descId} className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <span>
                {kindLabel}
                <AnimatedDots />
              </span>
            </p>
            {(context || groupLabel) && (
              <p className="mt-3 inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-foreground/10 px-2.5 py-1 text-xs text-muted-foreground">
                <ContextIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{groupLabel ? `with ${groupLabel}` : isDM ? context : `in ${context}`}</span>
              </p>
            )}
            {inAnotherCall && (
              <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                Accepting will end your current call.
              </p>
            )}
          </div>

          <div className="relative px-6 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6">
            <div className="flex items-start justify-center gap-6 sm:gap-8">
              <RoundAction
                label="Decline"
                tone="red"
                onClick={() => void decline(call.id)}
                icon={<PhoneOff className="size-6" />}
              />
              {isVideo ? (
                <>
                  <RoundAction
                    label="Audio"
                    tone="neutral"
                    onClick={() => void accept(call.id, false)}
                    icon={<Phone className="size-6" />}
                  />
                  <RoundAction
                    ref={acceptRef}
                    label="Video"
                    tone="green"
                    onClick={() => void accept(call.id, true)}
                    icon={<Video className="wk-call-wiggle size-6" />}
                  />
                </>
              ) : (
                <RoundAction
                  ref={acceptRef}
                  label="Accept"
                  tone="green"
                  onClick={() => void accept(call.id, false)}
                  icon={<Phone className="wk-call-wiggle size-6" />}
                />
              )}
            </div>
            {!isVideo && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => void accept(call.id, true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:hover:bg-white/10"
                >
                  <Video className="size-3.5" aria-hidden />
                  Accept with video
                </button>
              </div>
            )}

            {queued.length > 0 && (
              <QueuedCalls queued={queued} />
            )}

            <p className="mt-4 hidden items-center justify-center gap-3 text-[11px] text-muted-foreground sm:flex">
              <span>
                <Kbd>Enter</Kbd> accept
              </span>
              <span aria-hidden>·</span>
              <span>
                <Kbd>Esc</Kbd> decline
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function QueuedCalls({ queued }: { queued: IncomingRing[] }) {
  const { memberById } = useWorkspace();
  const first = memberById[queued[0].caller_id]?.full_name ?? "Someone";
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <span className="flex -space-x-1">
        {queued.slice(0, 3).map((q) => (
          <UserAvatar
            key={q.call.id}
            id={q.caller_id}
            name={memberById[q.caller_id]?.full_name ?? "?"}
            size="sm"
            className="rounded-[5px] ring-2 ring-popover"
          />
        ))}
      </span>
      <span>
        {queued.length === 1 ? `${first} is also calling` : `${queued.length} more calls waiting`}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 rounded border border-foreground/15 bg-foreground/[0.04] px-1 py-px font-sans text-[10px] font-medium">
      {children}
    </kbd>
  );
}

function RoundAction({
  label,
  tone,
  icon,
  onClick,
  ref,
}: {
  label: string;
  tone: "red" | "green" | "neutral";
  icon: React.ReactNode;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={label === "Audio" ? "Accept with audio only" : label === "Video" ? "Accept with video" : label}
        className={cn(
          "flex size-16 items-center justify-center rounded-full shadow-lg transition-[transform,background-color,box-shadow] duration-150 hover:scale-105 focus-visible:ring-4 focus-visible:outline-none active:scale-95",
          tone === "red" && "bg-red-500 text-white shadow-red-500/30 hover:bg-red-600 focus-visible:ring-red-500/40",
          tone === "green" &&
            "bg-emerald-500 text-white shadow-emerald-500/30 hover:bg-emerald-600 focus-visible:ring-emerald-500/40",
          tone === "neutral" &&
            "bg-foreground/[0.08] text-foreground shadow-black/5 hover:bg-foreground/[0.12] focus-visible:ring-ring/50 dark:bg-white/12 dark:hover:bg-white/20",
        )}
      >
        {icon}
      </button>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}
