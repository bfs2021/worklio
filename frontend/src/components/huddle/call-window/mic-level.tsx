"use client";

import { type Room, Track } from "livekit-client";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A tiny live input-level meter for my microphone. Reads the local mic track through a Web
 * Audio analyser and writes straight to the DOM (no React re-render per frame). It follows
 * device switches because it re-checks the underlying MediaStreamTrack every frame.
 */
export function MicLevel({ room, enabled, className }: { room: Room | null; enabled: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!room || !enabled || !el) return;
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let current: MediaStreamTrack | null = null;
    let raf = 0;
    let level = 0;
    const buf = new Uint8Array(512);

    const tick = () => {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const mst = pub?.track?.mediaStreamTrack ?? null;
      if (mst !== current) {
        source?.disconnect();
        source = null;
        current = mst;
        if (mst && mst.readyState === "live") {
          try {
            ctx ??= new AudioCtx();
            if (ctx.state === "suspended") void ctx.resume().catch(() => {});
            analyser ??= Object.assign(ctx.createAnalyser(), { fftSize: 512, smoothingTimeConstant: 0.3 });
            source = ctx.createMediaStreamSource(new MediaStream([mst]));
            source.connect(analyser);
          } catch {
            source = null;
          }
        }
      }
      let target = 0;
      if (analyser && source && !pub?.isMuted) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      }
      // Fast attack, slow release.
      level = target > level ? target : level * 0.86 + target * 0.14;
      el.style.transform = `scaleX(${level.toFixed(3)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      source?.disconnect();
      void ctx?.close().catch(() => {});
      el.style.transform = "scaleX(0)";
    };
  }, [room, enabled]);

  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-x-2.5 bottom-1.5 h-[3px] overflow-hidden rounded-full", className)}>
      <span
        ref={ref}
        className="block h-full w-full origin-left rounded-full bg-emerald-400"
        style={{ transform: "scaleX(0)" }}
      />
    </span>
  );
}
