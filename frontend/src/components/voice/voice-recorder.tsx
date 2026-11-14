"use client";

import { ChevronLeft, Loader2, Mic, Pause, SendHorizontal, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Message } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { RecordingSession, retainSession } from "./capture";
import { canRecord, formatClock, mediaErrorMessage, sendErrorMessage, sendRecording, VOICE_MAX_MS } from "./media";
import { VoicePlayer } from "./voice-player";

/* ------------------------------------------------------------------ */
/* Press-and-hold gesture (touch)                                      */
/* ------------------------------------------------------------------ */

export type HoldOutcome = "tap" | "send" | "cancel";
type HoldSnapshot = { active: boolean; dx: number };

/** Slide this far left (px) while holding to cancel. */
const CANCEL_DISTANCE = 96;
/** Releases quicker than this switch to hands-free mode instead of sending. */
const TAP_MS = 350;

/** Tracks a touch hold on the mic button after the button itself has been replaced by the recorder. */
export class HoldGesture {
  private snapshot: HoldSnapshot = { active: true, dx: 0 };
  private listeners = new Set<() => void>();
  private outcome: HoldOutcome | null = null;
  private handler: ((o: HoldOutcome) => void) | null = null;
  private consumed = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;

  move(dx: number) {
    const clamped = Math.min(0, Math.round(dx));
    if (clamped === this.snapshot.dx || !this.snapshot.active) return;
    this.snapshot = { ...this.snapshot, dx: clamped };
    this.listeners.forEach((fn) => fn());
  }

  release(outcome: HoldOutcome) {
    if (this.outcome) return;
    this.outcome = outcome;
    this.snapshot = { active: false, dx: 0 };
    this.listeners.forEach((fn) => fn());
    this.flush();
  }

  /** Register the release handler; fires immediately if the finger already lifted. */
  onRelease(fn: (o: HoldOutcome) => void) {
    this.handler = fn;
    this.flush();
    return () => {
      if (this.handler === fn) this.handler = null;
    };
  }

  private flush() {
    if (this.outcome && this.handler && !this.consumed) {
      this.consumed = true;
      this.handler(this.outcome);
    }
  }
}

const inactive: HoldSnapshot = { active: false, dx: 0 };
const inactiveHold = () => inactive;
const noopSubscribe = () => () => {};

export type VoiceStart = { session: RecordingSession; gesture: HoldGesture | null };

/* ------------------------------------------------------------------ */
/* Mic button                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mic button for the composer. Click (or Enter/Space) starts hands-free recording;
 * on touch screens, press and hold to record, release to send, slide left to cancel.
 */
export function VoiceRecordButton({
  onStart,
  disabled,
  className,
}: {
  onStart: (start: VoiceStart) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [opening, setOpening] = useState(false);
  const ignoreClick = useRef(false);

  const open = async (gesture: HoldGesture | null) => {
    if (!canRecord()) {
      toast.error("Voice messages need a browser with microphone recording support.");
      gesture?.release("cancel");
      return;
    }
    setOpening(true);
    try {
      const session = await RecordingSession.open("audio", VOICE_MAX_MS);
      session.start();
      onStart({ session, gesture });
    } catch (err) {
      gesture?.release("cancel");
      toast.error(mediaErrorMessage(err, "microphone"));
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      disabled={disabled || opening}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") ignoreClick.current = false;
        if (e.pointerType === "mouse" || e.button !== 0 || disabled || opening) return;
        // Touch / pen: press-and-hold. Listen on window because the button unmounts once recording starts.
        e.preventDefault();
        ignoreClick.current = true;
        window.setTimeout(() => (ignoreClick.current = false), 1000);
        const x0 = e.clientX;
        const t0 = performance.now();
        const gesture = new HoldGesture();
        const onMove = (ev: PointerEvent) => gesture.move(ev.clientX - x0);
        const onEnd = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
          const dx = ev.clientX - x0;
          if (ev.type === "pointercancel" || performance.now() - t0 < TAP_MS) gesture.release("tap");
          else gesture.release(dx <= -CANCEL_DISTANCE ? "cancel" : "send");
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
        void open(gesture);
      }}
      onClick={() => {
        if (ignoreClick.current) {
          ignoreClick.current = false;
          return;
        }
        void open(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Record voice message"
      title="Record voice message (hold on touch screens)"
      className={cn(
        "touch-none rounded p-2 text-muted-foreground outline-none select-none [-webkit-touch-callout:none] hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 sm:p-1.5",
        className,
      )}
    >
      {opening ? <Loader2 className="size-[18px] animate-spin" /> : <Mic className="size-[18px]" />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Live waveform                                                       */
/* ------------------------------------------------------------------ */

/** Scrolling level bars drawn on a canvas straight from the session (no React re-renders per frame). */
function LiveWaveform({ session, className }: { session: RecordingSession; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = el.clientWidth;
      h = el.clientHeight;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const BAR = 3;
    const GAP = 2;
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const color = getComputedStyle(el).color;
      const count = Math.max(1, Math.floor(w / (BAR + GAP)));
      const levels = session.levels;
      const live = session.getSnapshot().status === "recording" ? session.level() : 0;
      for (let i = 0; i < count; i++) {
        // Newest sample on the right; the very last bar breathes with the live input.
        const idx = levels.length - count + i;
        const v = i === count - 1 && live ? Math.max(live, levels[levels.length - 1] ?? 0) : idx >= 0 ? levels[idx] : 0;
        const bh = Math.max(3, Math.min(h, v * h * 1.1));
        const x = i * (BAR + GAP);
        ctx.globalAlpha = idx >= 0 ? 0.35 + 0.65 * Math.min(1, v * 2) : 0.18;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, (h - bh) / 2, BAR, bh, 1.5);
        else ctx.rect(x, (h - bh) / 2, BAR, bh);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [session]);

  return <canvas ref={canvas} aria-hidden className={cn("block h-8 min-w-0 flex-1", className)} />;
}

/* ------------------------------------------------------------------ */
/* Recorder bar                                                        */
/* ------------------------------------------------------------------ */

const iconBtn =
  "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-50 sm:size-8";

/**
 * Replaces the composer's text area while a voice message is recorded / previewed.
 * Sends through the normal message endpoint, so it works in channels, DMs and threads.
 */
export function VoiceRecorder({
  start,
  workspaceId,
  channelId,
  parentId,
  onSent,
  onClose,
}: {
  start: VoiceStart;
  workspaceId: string;
  channelId: string;
  parentId?: string;
  onSent?: (m: Message) => void;
  onClose: () => void;
}) {
  const { session, gesture } = start;
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const hold = useSyncExternalStore(
    gesture?.subscribe ?? noopSubscribe,
    gesture?.getSnapshot ?? inactiveHold,
    gesture?.getSnapshot ?? inactiveHold,
  );
  const [sending, setSending] = useState(false);
  const sendBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => retainSession(session), [session]);

  const discard = () => {
    session.dispose();
    onClose();
  };

  const send = async () => {
    if (sending) return;
    const elapsed = session.getSnapshot().status === "stopped" ? session.getSnapshot().elapsedMs : session.elapsed();
    if (elapsed < 600) {
      toast.info("That recording was too short.");
      discard();
      return;
    }
    setSending(true);
    try {
      const blob = await session.stop();
      const final = session.getSnapshot();
      if (!blob || blob.size === 0) throw new Error("Nothing was recorded");
      const msg = await sendRecording({
        workspaceId,
        channelId,
        parentId,
        blob,
        kind: "voice",
        durationMs: final.elapsedMs,
        waveform: final.peaks,
      });
      onSent?.(msg);
      session.dispose();
      onClose();
    } catch (err) {
      toast.error(sendErrorMessage(err, "Voice message"));
      setSending(false);
    }
  };

  // Latest handlers for the one-shot gesture callback below.
  const handlers = useRef({ send, discard });
  useEffect(() => {
    handlers.current = { send, discard };
  });

  // Touch hold released: send, cancel, or (quick tap) stay in hands-free mode.
  useEffect(() => {
    if (!gesture) return;
    return gesture.onRelease((outcome) =>
      queueMicrotask(() => {
        if (outcome === "cancel") handlers.current.discard();
        else if (outcome === "send") void handlers.current.send();
        else requestAnimationFrame(() => sendBtn.current?.focus({ preventScroll: true }));
      }),
    );
  }, [gesture]);

  // Hands-free mode: put focus on Send so Enter sends and Esc discards right away.
  useEffect(() => {
    if (!gesture) sendBtn.current?.focus({ preventScroll: true });
  }, [gesture]);

  // Hitting the 5-minute cap stops into preview.
  useEffect(() => {
    if (snap.stopReason === "max") toast.info("Voice messages can be up to 5 minutes.");
  }, [snap.stopReason]);

  const holding = hold.active;
  const cancelArmed = hold.dx <= -CANCEL_DISTANCE;
  const recording = snap.status === "recording" || snap.status === "paused";
  const remaining = VOICE_MAX_MS - snap.elapsedMs;

  return (
    <div
      role="group"
      aria-label="Voice message recorder"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          discard();
        }
      }}
      className="flex min-h-14 items-center gap-1.5 px-2 py-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 sm:gap-2"
    >
      <span className="sr-only" aria-live="polite">
        {snap.status === "recording" ? "Recording" : snap.status === "paused" ? "Recording paused" : snap.status === "stopped" ? "Recording ready to send" : ""}
      </span>

      {!holding && (
        <button type="button" onClick={discard} disabled={sending} aria-label="Discard recording" title="Discard (Esc)" className={cn(iconBtn, "hover:bg-destructive/10 hover:text-destructive")}>
          <Trash2 className="size-[18px]" />
        </button>
      )}

      {recording || snap.status === "idle" ? (
        <>
          <span className="flex shrink-0 items-center gap-2 pl-1">
            <span className="relative flex size-2.5">
              {snap.status === "recording" && (
                <span className="absolute inset-0 rounded-full bg-red-500 opacity-60 motion-safe:animate-ping" />
              )}
              <span className={cn("relative size-2.5 rounded-full", snap.status === "paused" ? "bg-amber-500" : "bg-red-500")} />
            </span>
            <span className="w-11 text-sm font-semibold tabular-nums" aria-label={`Recorded ${formatClock(snap.elapsedMs)}`}>
              {formatClock(snap.elapsedMs)}
            </span>
          </span>

          {holding ? (
            <>
              <LiveWaveform session={session} className="hidden text-foreground/70 min-[400px]:block" />
              <span
                className={cn(
                  "ml-auto flex shrink-0 items-center gap-0.5 text-sm transition-colors",
                  cancelArmed ? "font-semibold text-destructive" : "text-muted-foreground",
                )}
                style={{ transform: `translateX(${Math.max(-CANCEL_DISTANCE, hold.dx)}px)` }}
              >
                <ChevronLeft className="size-4 motion-safe:animate-pulse" />
                {cancelArmed ? "Release to cancel" : "Slide to cancel"}
              </span>
              <span
                aria-hidden
                className={cn(
                  "ml-1 flex size-12 shrink-0 items-center justify-center rounded-full text-white shadow-lg transition-colors",
                  cancelArmed ? "bg-destructive" : "bg-red-500",
                )}
                style={{ transform: `scale(${1.1 + Math.min(0.25, session.levels[session.levels.length - 1] ?? 0)})` }}
              >
                <Mic className="size-5" />
              </span>
            </>
          ) : (
            <>
              <LiveWaveform session={session} className={snap.status === "paused" ? "text-foreground/35" : "text-foreground/70"} />
              {remaining <= 30_000 && (
                <span className="hidden shrink-0 text-xs text-destructive tabular-nums sm:inline">{formatClock(remaining)} left</span>
              )}
              <button
                type="button"
                onClick={() => (snap.status === "paused" ? session.resume() : session.pause())}
                disabled={sending}
                aria-label={snap.status === "paused" ? "Resume recording" : "Pause recording"}
                title={snap.status === "paused" ? "Resume" : "Pause"}
                className={iconBtn}
              >
                {snap.status === "paused" ? <Mic className="size-[18px] text-red-500" /> : <Pause className="size-[18px] fill-current" />}
              </button>
              <button
                type="button"
                onClick={() => void session.stop()}
                disabled={sending}
                aria-label="Stop and preview"
                title="Stop and preview"
                className={iconBtn}
              >
                <Square className="size-4 fill-current" />
              </button>
            </>
          )}
        </>
      ) : (
        <VoicePlayer
          bare
          src={snap.url ?? ""}
          durationMs={snap.elapsedMs}
          waveform={snap.peaks}
          seed="preview"
          className="flex-1"
        />
      )}

      {!holding && (
        <button
          ref={sendBtn}
          type="button"
          onClick={() => void send()}
          disabled={sending}
          aria-label="Send voice message"
          title="Send (Enter)"
          className="ml-0.5 flex h-9 shrink-0 items-center justify-center rounded-full bg-send px-3.5 text-white shadow-sm transition hover:brightness-110 focus-visible:ring-3 focus-visible:ring-send/40 focus-visible:outline-none active:scale-95 disabled:opacity-70 sm:h-8"
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
        </button>
      )}
    </div>
  );
}
