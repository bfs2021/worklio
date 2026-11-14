"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { BUBBLE_MARGIN, BUBBLE_MAX, BUBBLE_MIN, type BubbleLayout, bubbleCenter, type Corner, nearestCorner } from "./engine";

/** <video> bound to a MediaStream. */
export function StreamVideo({
  stream,
  mirrored,
  fit = "cover",
  className,
  label,
}: {
  stream: MediaStream | null;
  mirrored?: boolean;
  fit?: "cover" | "contain";
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      muted
      playsInline
      autoPlay
      aria-label={label}
      className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain", mirrored && "-scale-x-100", className)}
    />
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The camera bubble on the live preview. Drag to move (snaps to the nearest corner on release),
 * drag the knob to resize. Keyboard: arrow keys pick a corner, +/- resize.
 */
export function CameraBubble({
  stream,
  layout,
  aspect,
  onLayout,
  interactive = true,
}: {
  stream: MediaStream | null;
  layout: BubbleLayout;
  /** Width / height of the stage. */
  aspect: number;
  onLayout: (l: BubbleLayout) => void;
  interactive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<{ dx: number; dy: number; mode: "move" | "resize" } | null>(null);
  const [drag, setDrag] = useState<{ cx: number; cy: number } | null>(null);
  const [size, setSize] = useState<number | null>(null);

  const effective: BubbleLayout = { corner: layout.corner, size: size ?? layout.size };
  const snapped = bubbleCenter(effective, aspect);
  const cx = drag?.cx ?? snapped.cx;
  const cy = drag?.cy ?? snapped.cy;
  const r = snapped.r;
  const ry = snapped.ry;

  const stageRect = () => ref.current?.parentElement?.getBoundingClientRect() ?? null;

  const onPointerDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    if (!interactive || e.button > 0) return;
    const rect = stageRect();
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    grab.current = { dx: px - cx, dy: py - cy, mode };
    if (mode === "move") setDrag({ cx, cy });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = grab.current;
    const rect = stageRect();
    if (!g || !rect) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    if (g.mode === "move") {
      setDrag({ cx: clamp(px - g.dx, r, 1 - r), cy: clamp(py - g.dy, ry, 1 - ry) });
    } else {
      const left = layout.corner.endsWith("l");
      const span = left ? px - BUBBLE_MARGIN : 1 - BUBBLE_MARGIN - px;
      setSize(clamp(span, BUBBLE_MIN, BUBBLE_MAX));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = grab.current;
    grab.current = null;
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    if (!g) return;
    if (g.mode === "move" && drag) onLayout({ ...layout, size: effective.size, corner: nearestCorner(drag.cx, drag.cy) });
    if (g.mode === "resize" && size != null) onLayout({ ...layout, size });
    setDrag(null);
    setSize(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    const v = layout.corner[0] as "t" | "b";
    const hz = layout.corner[1] as "l" | "r";
    let next: Corner | null = null;
    if (e.key === "ArrowUp") next = `t${hz}`;
    else if (e.key === "ArrowDown") next = `b${hz}`;
    else if (e.key === "ArrowLeft") next = `${v}l`;
    else if (e.key === "ArrowRight") next = `${v}r`;
    if (next) {
      e.preventDefault();
      onLayout({ ...layout, corner: next });
      return;
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      onLayout({ ...layout, size: clamp(layout.size + 0.03, BUBBLE_MIN, BUBBLE_MAX) });
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      onLayout({ ...layout, size: clamp(layout.size - 0.03, BUBBLE_MIN, BUBBLE_MAX) });
    }
  };

  const knobOnLeft = layout.corner.endsWith("r");
  const knobOnTop = layout.corner.startsWith("b");
  const cornerName = { tl: "top left", tr: "top right", bl: "bottom left", br: "bottom right" }[layout.corner];

  return (
    <div
      ref={ref}
      role={interactive ? "group" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `Camera bubble, ${cornerName}. Arrow keys move it, plus and minus resize.` : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => onPointerDown(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "group/bubble absolute z-[5] aspect-square touch-none rounded-full outline-none",
        "shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-[3px] ring-white/90 focus-visible:ring-sky-400",
        interactive ? (drag ? "cursor-grabbing" : "cursor-grab") : "pointer-events-none",
        !drag && size == null && "motion-safe:transition-[left,top,width] motion-safe:duration-300 motion-safe:ease-out",
      )}
      style={{ left: `${(cx - r) * 100}%`, top: `${(cy - ry) * 100}%`, width: `${effective.size * 100}%` }}
    >
      <div className="size-full overflow-hidden rounded-full bg-zinc-800">
        <StreamVideo stream={stream} mirrored label="Camera preview" />
      </div>
      {interactive && (
        <span
          role="presentation"
          onPointerDown={(e) => onPointerDown(e, "resize")}
          title="Drag to resize"
          className={cn(
            "absolute size-4 rounded-full border-2 border-white bg-sky-500 opacity-0 shadow transition-opacity group-hover/bubble:opacity-100 group-focus-visible/bubble:opacity-100",
            knobOnLeft ? "left-[8%]" : "right-[8%]",
            knobOnTop ? "top-[8%]" : "bottom-[8%]",
            knobOnLeft === knobOnTop ? "cursor-nwse-resize" : "cursor-nesw-resize",
          )}
        />
      )}
    </div>
  );
}

/** Tiny live input level bar for the selected microphone. */
export function MicMeter({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let level = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      level = Math.max(rms * 3.2, level * 0.86);
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, level)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => undefined);
    };
  }, [stream]);
  return (
    <span className={cn("relative block h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)} aria-hidden>
      <span ref={bar} className="absolute inset-0 origin-left scale-x-0 rounded-full bg-gradient-to-r from-emerald-400 via-emerald-400 to-amber-400" />
    </span>
  );
}
