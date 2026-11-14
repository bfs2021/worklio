"use client";

import { useRef } from "react";

import { formatClock } from "@/components/voice/media";
import { cn } from "@/lib/utils";

const MIN_SPAN = 1;

/** Two-handle range for choosing the part of the recording to keep. Times are in seconds. */
export function TrimBar({
  duration,
  start,
  end,
  onChange,
  onScrub,
  disabled,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  onScrub?: (t: number) => void;
  disabled?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const d = Math.max(duration, 0.001);

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * d;
  };

  const set = (which: "start" | "end", t: number) => {
    if (which === "start") {
      const s = Math.max(0, Math.min(t, end - MIN_SPAN));
      onChange(s, end);
      onScrub?.(s);
    } else {
      const e = Math.min(d, Math.max(t, start + MIN_SPAN));
      onChange(start, e);
      onScrub?.(e);
    }
  };

  const handleProps = (which: "start" | "end") => {
    const value = which === "start" ? start : end;
    return {
      role: "slider" as const,
      tabIndex: disabled ? -1 : 0,
      "aria-label": which === "start" ? "Trim start" : "Trim end",
      "aria-valuemin": 0,
      "aria-valuemax": Math.round(d),
      "aria-valuenow": Math.round(value),
      "aria-valuetext": formatClock(value * 1000),
      "aria-disabled": disabled || undefined,
      onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        dragging.current = which;
      },
      onPointerMove: (e: React.PointerEvent<HTMLSpanElement>) => {
        if (dragging.current === which) set(which, timeAt(e.clientX));
      },
      onPointerUp: (e: React.PointerEvent<HTMLSpanElement>) => {
        dragging.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (disabled) return;
        const step = e.shiftKey ? 5 : 0.5;
        let next: number | null = null;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = d;
        if (next == null) return;
        e.preventDefault();
        set(which, next);
      },
    };
  };

  const sPct = (start / d) * 100;
  const ePct = (end / d) * 100;

  return (
    <div className={cn("select-none", disabled && "opacity-50")}>
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-400 tabular-nums">
        <span>{formatClock(start * 1000)}</span>
        <span className="text-zinc-300">Keeping {formatClock((end - start) * 1000)}</span>
        <span>{formatClock(end * 1000)}</span>
      </div>
      <div
        ref={track}
        className="relative h-9 cursor-pointer rounded-lg bg-white/5 ring-1 ring-white/10"
        onPointerDown={(e) => {
          if (disabled) return;
          onScrub?.(Math.max(start, Math.min(end, timeAt(e.clientX))));
        }}
      >
        {/* Filmstrip texture */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-lg opacity-40"
          style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 14px)" }}
        />
        <div aria-hidden className="absolute inset-y-0 left-0 rounded-l-lg bg-black/55" style={{ width: `${sPct}%` }} />
        <div aria-hidden className="absolute inset-y-0 right-0 rounded-r-lg bg-black/55" style={{ width: `${100 - ePct}%` }} />
        <div
          aria-hidden
          className="absolute inset-y-0 border-y-2 border-amber-400"
          style={{ left: `${sPct}%`, width: `${ePct - sPct}%` }}
        />
        {(["start", "end"] as const).map((which) => (
          <span
            key={which}
            {...handleProps(which)}
            className={cn(
              "absolute inset-y-0 z-10 flex w-3.5 touch-none items-center justify-center bg-amber-400 outline-none focus-visible:ring-2 focus-visible:ring-white",
              which === "start" ? "-translate-x-full rounded-l-md" : "rounded-r-md",
              disabled ? "cursor-not-allowed" : "cursor-ew-resize",
            )}
            style={{ left: `${which === "start" ? sPct : ePct}%` }}
          >
            <span className="h-3.5 w-0.5 rounded-full bg-amber-950/70" />
          </span>
        ))}
      </div>
    </div>
  );
}
