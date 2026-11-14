"use client";

import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { formatClock, spokenDuration } from "./media";

/**
 * Static waveform with a played/unplayed split. When `onSeek` is set it becomes an
 * accessible slider: click or drag to seek, ←/→ ±5 s, Home/End.
 */
export function Waveform({
  peaks,
  progress,
  durationMs,
  onSeek,
  onScrubChange,
  label = "Seek",
  className,
}: {
  peaks: number[];
  /** 0–1 */
  progress: number;
  durationMs: number;
  onSeek?: (fraction: number) => void;
  /** Called with true while the user drags, so the player can hold its progress updates. */
  onScrubChange?: (scrubbing: boolean) => void;
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? progress;
  const interactive = !!onSeek;

  const fractionAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const stepMs = 5000;
  const step = durationMs > 0 ? stepMs / durationMs : 0.05;

  return (
    <div
      ref={ref}
      role={interactive ? "slider" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? label : undefined}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? Math.round(durationMs / 1000) : undefined}
      aria-valuenow={interactive ? Math.round((shown * durationMs) / 1000) : undefined}
      aria-valuetext={interactive ? `${spokenDuration(shown * durationMs)} of ${spokenDuration(durationMs)}` : undefined}
      aria-hidden={interactive ? undefined : true}
      onPointerDown={
        interactive
          ? (e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setScrub(fractionAt(e.clientX));
              onScrubChange?.(true);
            }
          : undefined
      }
      onPointerMove={interactive ? (e) => scrub != null && setScrub(fractionAt(e.clientX)) : undefined}
      onPointerUp={
        interactive
          ? (e) => {
              if (scrub == null) return;
              const f = fractionAt(e.clientX);
              setScrub(null);
              onScrubChange?.(false);
              onSeek?.(f);
            }
          : undefined
      }
      onPointerCancel={
        interactive
          ? () => {
              setScrub(null);
              onScrubChange?.(false);
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (e) => {
              let next: number | null = null;
              if (e.key === "ArrowRight" || e.key === "ArrowUp") next = progress + step;
              else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = progress - step;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = 0.999;
              if (next == null) return;
              e.preventDefault();
              onSeek?.(Math.min(1, Math.max(0, next)));
            }
          : undefined
      }
      title={interactive ? formatClock(shown * durationMs) : undefined}
      className={cn(
        "group/wave relative flex h-8 min-w-0 touch-none items-center gap-[2px] select-none",
        interactive && "cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
    >
      {peaks.map((p, i) => {
        const played = (i + 0.5) / peaks.length <= shown;
        return (
          <span
            key={i}
            className={cn(
              "min-w-[2px] flex-1 rounded-full transition-colors duration-150",
              played ? "bg-send" : "bg-foreground/25 group-hover/wave:bg-foreground/35",
            )}
            style={{ height: `${Math.max(12, Math.min(100, p))}%` }}
          />
        );
      })}
    </div>
  );
}
