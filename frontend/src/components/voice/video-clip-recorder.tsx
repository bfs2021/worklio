"use client";

import { Loader2, RotateCcw, SendHorizontal, Video } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Message } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { RecordingSession, retainSession } from "./capture";
import { canRecord, formatClock, mediaErrorMessage, sendErrorMessage, sendRecording, VIDEO_MAX_MS } from "./media";
import { VideoClipPlayer } from "./video-clip-player";

/** Camera button for the composer: opens a dialog to record and send a short video clip. */
export function VideoClipButton({
  workspaceId,
  channelId,
  parentId,
  onSent,
  className,
}: {
  workspaceId: string;
  channelId: string;
  parentId?: string;
  onSent?: (m: Message) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<RecordingSession | null>(null);
  // Bumped on every open/close so a camera that finishes opening after the dialog was closed
  // (or the composer unmounted) is stopped instead of staying on in the background.
  const attempt = useRef(0);

  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );

  const start = async () => {
    if (!canRecord()) {
      toast.error("Video clips need a browser with camera recording support.");
      return;
    }
    if (open) return;
    const my = ++attempt.current;
    setOpen(true);
    try {
      const s = await RecordingSession.open("video", VIDEO_MAX_MS);
      if (attempt.current !== my) {
        s.dispose();
        return;
      }
      setSession(s);
    } catch (err) {
      if (attempt.current !== my) return;
      setOpen(false);
      toast.error(mediaErrorMessage(err, "camera"));
    }
  };

  const close = () => {
    attempt.current++;
    session?.dispose();
    setSession(null);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void start()}
        aria-label="Record video clip"
        title="Record video clip"
        className={cn("rounded p-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:p-1.5", className)}
      >
        <Video className="size-[18px]" />
      </button>
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
          <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-3">
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold">Record a video clip</DialogTitle>
              <DialogDescription className="text-xs">Up to {VIDEO_MAX_MS / 60_000} minutes. Only sent when you choose Send.</DialogDescription>
            </div>
          </div>
          {session ? (
            <ClipStudio
              session={session}
              workspaceId={workspaceId}
              channelId={channelId}
              parentId={parentId}
              onCancel={close}
              onSent={(m) => {
                onSent?.(m);
                close();
              }}
            />
          ) : (
            <div className="flex aspect-video items-center justify-center bg-black text-sm text-white/70">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Starting camera…
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

function ClipStudio({
  session,
  workspaceId,
  channelId,
  parentId,
  onCancel,
  onSent,
}: {
  session: RecordingSession;
  workspaceId: string;
  channelId: string;
  parentId?: string;
  onCancel: () => void;
  onSent: (m: Message) => void;
}) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const live = useRef<HTMLVideoElement>(null);
  const recordBtn = useRef<HTMLButtonElement>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => retainSession(session), [session]);

  useEffect(() => {
    const el = live.current;
    if (!el) return;
    el.srcObject = session.stream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [session, snap.status]);

  useEffect(() => {
    recordBtn.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (snap.stopReason === "max") toast.info("Video clips can be up to 2 minutes.");
  }, [snap.stopReason]);

  const recording = snap.status === "recording" || snap.status === "paused";
  const stopped = snap.status === "stopped";
  const progress = Math.min(1, snap.elapsedMs / VIDEO_MAX_MS);

  const send = async () => {
    if (!snap.blob || sending) return;
    if (snap.elapsedMs < 700) {
      toast.info("That clip was too short.");
      return;
    }
    setSending(true);
    try {
      const msg = await sendRecording({
        workspaceId,
        channelId,
        parentId,
        blob: snap.blob,
        kind: "video_clip",
        durationMs: snap.elapsedMs,
      });
      onSent(msg);
    } catch (err) {
      toast.error(sendErrorMessage(err, "Video clip"));
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="relative aspect-[3/4] max-h-[60dvh] w-full overflow-hidden bg-black min-[480px]:aspect-video">
        {stopped && snap.url ? (
          <div className="flex size-full items-center justify-center">
            <VideoClipPlayer src={snap.url} durationMs={snap.elapsedMs} className="h-full w-auto rounded-none shadow-none ring-0 sm:w-auto" />
          </div>
        ) : (
          <video
            ref={live}
            muted
            playsInline
            autoPlay
            aria-label="Camera preview"
            className="size-full -scale-x-100 object-cover"
          />
        )}

        {recording && (
          <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-bold text-white tabular-nums backdrop-blur-sm">
            <span className="size-2 rounded-full bg-red-500 motion-safe:animate-pulse" />
            {formatClock(snap.elapsedMs)}
            <span className="font-normal text-white/70">/ {formatClock(VIDEO_MAX_MS)}</span>
          </span>
        )}

        {!stopped && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center">
            <button
              ref={recordBtn}
              type="button"
              onClick={() => (recording ? void session.stop() : session.start())}
              aria-label={recording ? "Stop recording" : "Start recording"}
              className="group/rec relative flex size-[76px] items-center justify-center rounded-full focus-visible:outline-none"
            >
              <svg viewBox="0 0 76 76" className="absolute inset-0 size-full -rotate-90" aria-hidden>
                <circle cx="38" cy="38" r={RING_R} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="4" />
                <circle
                  cx="38"
                  cy="38"
                  r={RING_R}
                  fill="none"
                  stroke={recording ? "#ef4444" : "white"}
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={recording ? RING_C * (1 - progress) : 0}
                  className="transition-[stroke-dashoffset] duration-100 ease-linear"
                />
              </svg>
              <span
                className={cn(
                  "bg-red-500 shadow-lg transition-all duration-200 group-focus-visible/rec:ring-4 group-focus-visible/rec:ring-white/60",
                  recording ? "size-7 rounded-md" : "size-14 rounded-full group-hover/rec:scale-95",
                )}
              />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-4 py-3">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {recording
            ? `${formatClock(VIDEO_MAX_MS - snap.elapsedMs)} left`
            : stopped
              ? `Clip ready · ${formatClock(snap.elapsedMs)}`
              : "Press the red button to start"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-sm font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Cancel
          </button>
          {stopped && (
            <>
              <button
                type="button"
                onClick={() => session.resetTake()}
                disabled={sending}
                className="flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" />
                Re-record
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-send px-3.5 text-sm font-bold text-white outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-send/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-70"
              >
                {sending ? <Loader2 className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
                Send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
