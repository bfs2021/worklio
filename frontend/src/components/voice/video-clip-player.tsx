"use client";

import { AlertCircle, Download, Maximize2, MonitorPlay, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Attachment } from "@/lib/api";
import { cn } from "@/lib/utils";

import { formatClock } from "./media";
import { claimPlayback, fixInfiniteDuration, isScanning, rateLabel, releasePlayback, usePlaybackRate } from "./playback";

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Rounded video card: first-frame poster, play overlay, duration badge, speed toggle, fullscreen. */
export function VideoClipPlayer({
  src,
  durationMs: knownDurationMs,
  downloadUrl,
  title,
  fit = "cover",
  className,
}: {
  src: string;
  durationMs?: number | null;
  downloadUrl?: string;
  /** Small label over the top-left corner (e.g. "Screen recording"). */
  title?: string;
  /** "contain" for screen content that must never be cropped. */
  fit?: "cover" | "contain";
  className?: string;
}) {
  const video = useRef<FullscreenVideo>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const [rate, cycle] = usePlaybackRate();
  const [failed, setFailed] = useState(false);

  const durationS = mediaDuration > 0 ? mediaDuration : knownDurationMs ? knownDurationMs / 1000 : 0;
  const progress = durationS > 0 ? Math.min(1, current / durationS) : 0;
  // "#t=0.1" makes browsers paint the first frame as a poster without downloading the clip.
  const poster = src.startsWith("blob:") ? src : `${src}#t=0.1`;

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const el = video.current;
    return () => {
      if (el && !el.paused) el.pause();
      releasePlayback(el);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const loop = () => {
      if (video.current && !isScanning(video.current)) setCurrent(video.current.currentTime);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      el.playbackRate = rate;
      el.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "NotSupportedError") setFailed(true);
      });
    } else el.pause();
  };

  const cycleRate = () => {
    const r = cycle();
    if (video.current) video.current.playbackRate = r;
  };

  const fullscreen = () => {
    const el = video.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (el.requestFullscreen) {
      void el.requestFullscreen().catch(() => el.webkitEnterFullscreen?.());
    } else el.webkitEnterFullscreen?.();
  };

  const seekFromBar = (clientX: number, target: HTMLElement) => {
    const el = video.current;
    const rect = target.getBoundingClientRect();
    if (!el || durationS <= 0 || rect.width === 0) return;
    const t = Math.min(durationS - 0.05, Math.max(0, ((clientX - rect.left) / rect.width) * durationS));
    setCurrent(t);
    fixInfiniteDuration(el, () => {
      el.currentTime = t;
    });
  };

  const portrait = aspect < 1;

  return (
    <div
      className={cn(
        "group/clip relative isolate overflow-hidden rounded-2xl bg-black shadow-sm ring-1 ring-foreground/10",
        portrait ? "w-52 sm:w-60" : "w-80 sm:w-96",
        "max-w-full",
        className,
      )}
      style={{ aspectRatio: String(aspect) }}
    >
      <video
        ref={video}
        src={poster}
        preload="metadata"
        playsInline
        onClick={toggle}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (el.videoWidth && el.videoHeight) setAspect(Math.min(2, Math.max(0.5, el.videoWidth / el.videoHeight)));
          if (Number.isFinite(el.duration)) setMediaDuration(el.duration);
          else if (!knownDurationMs) fixInfiniteDuration(el);
        }}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setMediaDuration(e.currentTarget.duration)}
        onPlay={(e) => {
          claimPlayback(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          if (isScanning(e.currentTarget)) return;
          setPlaying(false);
          setCurrent(0);
        }}
        onError={() => setFailed(true)}
        className={cn("size-full cursor-pointer", fit === "contain" ? "object-contain" : "object-cover")}
      />

      {title && (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex bg-gradient-to-b from-black/55 to-transparent px-2.5 pt-2 pb-6">
          <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur-sm">
            <MonitorPlay className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{title}</span>
          </span>
        </div>
      )}

      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 px-4 text-center text-xs text-white/80">
          <AlertCircle className="size-5" aria-hidden />
          <span>This browser can&apos;t play this video.</span>
          {downloadUrl && (
            <a href={downloadUrl} target="_blank" rel="noreferrer" download className="font-semibold text-white underline underline-offset-2">
              Download it
            </a>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause video" : "Play video"}
          className={cn(
            "absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
            "bg-black/45 text-white ring-1 ring-white/25 backdrop-blur-md transition duration-200",
            "hover:scale-105 hover:bg-black/60 focus-visible:ring-3 focus-visible:ring-white/70 focus-visible:outline-none",
            playing && "pointer-events-none scale-90 opacity-0 group-hover/clip:pointer-events-auto group-hover/clip:scale-100 group-hover/clip:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(hover:none)]:opacity-0",
          )}
        >
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="ml-1 size-6 fill-current" />}
        </button>
      )}

      {/* Bottom bar: duration / speed / fullscreen */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/60 to-transparent px-2.5 pt-8 pb-2">
        <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white tabular-nums backdrop-blur-sm">
          {playing || current > 0 ? `${formatClock(current * 1000)} / ` : ""}
          {durationS > 0 ? formatClock(durationS * 1000) : "--:--"}
        </span>
        <span className="pointer-events-auto flex items-center gap-1">
          <button
            type="button"
            onClick={cycleRate}
            aria-label={`Playback speed ${rateLabel(rate)}`}
            title="Playback speed"
            className="h-6 rounded-full bg-black/55 px-2 text-[11px] font-bold text-white tabular-nums outline-none backdrop-blur-sm hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {rateLabel(rate)}
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
              download
              aria-label="Download video"
              title="Download"
              className="flex size-6 items-center justify-center rounded-full bg-black/55 text-white outline-none backdrop-blur-sm hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <Download className="size-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={fullscreen}
            aria-label="Full screen"
            title="Full screen"
            className="flex size-6 items-center justify-center rounded-full bg-black/55 text-white outline-none backdrop-blur-sm hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </span>
      </div>

      {/* Thin, seekable progress line */}
      {durationS > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 h-1.5 cursor-pointer"
          onPointerDown={(e) => {
            e.stopPropagation();
            seekFromBar(e.clientX, e.currentTarget);
          }}
          aria-hidden
        >
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/20">
            <div className="h-full bg-white" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export function VideoClipAttachment({ attachment: a, className }: { attachment: Attachment; className?: string }) {
  if (a.kind === "screen_recording") {
    // Screen content: wider card, letterboxed rather than cropped.
    return (
      <VideoClipPlayer
        src={a.url}
        durationMs={a.duration_ms}
        downloadUrl={a.url}
        title="Screen recording"
        fit="contain"
        className={cn("w-[min(100%,36rem)] sm:w-[min(100%,36rem)]", className)}
      />
    );
  }
  return <VideoClipPlayer src={a.url} durationMs={a.duration_ms} downloadUrl={a.url} className={className} />;
}
