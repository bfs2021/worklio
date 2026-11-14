"use client";

import { Download, Loader2, Mic, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

import { fallbackWaveform, formatClock } from "./media";
import { claimPlayback, fixInfiniteDuration, isScanning, rateLabel, releasePlayback, usePlaybackRate } from "./playback";
import { Waveform } from "./waveform";

/**
 * Voice-message bubble: play/pause, seekable waveform, elapsed/total, 1× / 1.5× / 2×, download.
 * Used for posted voice messages (and other audio files) and for the recorder's preview.
 */
export function VoicePlayer({
  src,
  durationMs: knownDurationMs,
  waveform,
  seed,
  title,
  downloadUrl,
  bare,
  className,
}: {
  src: string;
  durationMs?: number | null;
  waveform?: number[] | null;
  /** Stable id used to generate a waveform when none is stored. */
  seed: string;
  /** Shown above the waveform for plain audio files (voice notes don't need one). */
  title?: string;
  downloadUrl?: string;
  /** No card chrome (used inside the composer recorder). */
  bare?: boolean;
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [rate, cycle] = usePlaybackRate();
  const [scrubbing, setScrubbing] = useState(false);
  const [started, setStarted] = useState(false);

  // The element's own duration is exact once known; the stored one (from the recorder clock)
  // can be off by a few hundred ms, which would skew seeking near the end.
  const durationS = mediaDuration > 0 ? mediaDuration : knownDurationMs ? knownDurationMs / 1000 : 0;
  const durationMs = durationS * 1000;
  const peaks = waveform?.length ? waveform : fallbackWaveform(seed);
  const progress = durationS > 0 ? Math.min(1, current / durationS) : 0;

  // Keep every player at the user's speed (changed here, in another player or another tab).
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  // A detached <audio> keeps playing: stop it when the bubble unmounts (scrolled away, deleted…).
  useEffect(() => {
    const el = audio.current;
    return () => {
      if (el && !el.paused) el.pause();
      releasePlayback(el);
    };
  }, []);

  // Smooth progress while playing (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!playing || scrubbing) return;
    let id = 0;
    const loop = () => {
      if (audio.current && !isScanning(audio.current)) setCurrent(audio.current.currentTime);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, scrubbing]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      el.playbackRate = rate;
      setStarted(true);
      setFailed(false);
      el.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFailed(true);
      });
    } else el.pause();
  };

  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || durationS <= 0) return;
    const t = Math.min(durationS - 0.05, Math.max(0, fraction * durationS));
    setCurrent(t);
    setStarted(true);
    // Recorder WebM has no duration/cues until scanned; resolve that first or the seek is ignored.
    fixInfiniteDuration(el, () => {
      el.currentTime = t;
    });
  };

  const cycleRate = () => {
    const r = cycle();
    if (audio.current) audio.current.playbackRate = r;
  };

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5",
        !bare && "w-[22rem] max-w-full rounded-2xl border bg-background py-2 pr-2.5 pl-2 shadow-xs",
        className,
      )}
    >
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = rate;
          if (Number.isFinite(el.duration)) setMediaDuration(el.duration);
          else if (!knownDurationMs) fixInfiniteDuration(el);
        }}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setMediaDuration(e.currentTarget.duration)}
        onPlay={(e) => {
          claimPlayback(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (!scrubbing && !isScanning(el)) setCurrent(el.currentTime);
        }}
        onEnded={(e) => {
          if (isScanning(e.currentTarget)) return;
          setPlaying(false);
          setCurrent(0);
          setStarted(false);
          if (audio.current) audio.current.currentTime = 0;
        }}
        onError={() => {
          setFailed(true);
          setPlaying(false);
          setWaiting(false);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center rounded-full bg-send text-white shadow-sm transition",
          "hover:brightness-110 active:scale-95 focus-visible:ring-3 focus-visible:ring-send/40 focus-visible:outline-none",
        )}
      >
        {waiting && playing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="ml-0.5 size-4 fill-current" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        {title && (
          <span className="flex min-w-0 items-center gap-1 text-xs font-bold">
            <Mic className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{title}</span>
          </span>
        )}
        <Waveform
          peaks={peaks}
          progress={progress}
          durationMs={durationMs}
          onSeek={durationS > 0 ? seek : undefined}
          onScrubChange={setScrubbing}
          label="Voice message position"
          className={title ? "h-6" : "h-8"}
        />
      </div>

      <span
        className="w-[4.5rem] shrink-0 text-right text-xs text-muted-foreground tabular-nums"
        aria-live="off"
      >
        {failed ? (
          <span className="text-destructive">Unavailable</span>
        ) : started || playing ? (
          formatClock(current * 1000)
        ) : durationS > 0 ? (
          formatClock(durationMs)
        ) : (
          "--:--"
        )}
      </span>

      <button
        type="button"
        onClick={cycleRate}
        aria-label={`Playback speed ${rateLabel(rate)}`}
        title="Playback speed"
        className={cn(
          "h-6 w-10 shrink-0 rounded-full border text-[11px] font-bold tabular-nums transition outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          rate === 1 ? "text-muted-foreground hover:bg-muted hover:text-foreground" : "border-send/40 bg-send/10 text-send",
        )}
      >
        {rateLabel(rate)}
      </button>

      {downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          download
          aria-label="Download voice message"
          title="Download"
          className="hidden size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
        >
          <Download className="size-4" />
        </a>
      )}
    </div>
  );
}

/** Convenience wrapper for a posted attachment. */
export function VoiceAttachment({ attachment: a }: { attachment: Attachment }) {
  return (
    <VoicePlayer
      src={a.url}
      durationMs={a.duration_ms}
      waveform={a.waveform}
      seed={a.id}
      title={a.kind === "voice" ? undefined : a.filename}
      downloadUrl={a.url}
    />
  );
}
