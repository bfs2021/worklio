"use client";

import { ConnectionQuality, type VideoTrack } from "livekit-client";
import { Hand, MicOff, Pin, PinOff, ScreenShare, SignalLow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { hueFor, UserAvatar } from "@/components/chat/user-avatar";
import { useMirrorSelf } from "@/components/effects/store";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import type { HuddleParticipantView } from "./types";

/** Renders a LiveKit video track into a <video>. */
export function VideoView({
  track,
  mirror,
  fit = "cover",
  className,
  ref: externalRef,
}: {
  track: VideoTrack;
  mirror?: boolean;
  fit?: "cover" | "contain";
  className?: string;
  ref?: (el: HTMLVideoElement | null) => void;
}) {
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, el]);
  const setRef = useCallback(
    (node: HTMLVideoElement | null) => {
      setEl(node);
      externalRef?.(node);
    },
    [externalRef],
  );
  return (
    <video
      ref={setRef}
      autoPlay
      muted
      playsInline
      className={cn(
        "size-full bg-black",
        fit === "cover" ? "object-cover" : "object-contain",
        mirror && "-scale-x-100",
        className,
      )}
    />
  );
}

/** A camera feed; my own is mirrored unless I turned "Mirror my video" off in Effects. */
export function CameraView({ track, isLocal, fit }: { track: VideoTrack; isLocal: boolean; fit?: "cover" | "contain" }) {
  const mirrorSelf = useMirrorSelf();
  return <VideoView track={track} mirror={isLocal && mirrorSelf} fit={fit} />;
}

/**
 * A participant's names: `name` is the raw display name (what avatars/initials must use),
 * `label` adds " (you)" for the local participant (for aria labels and tooltips).
 */
export function useParticipantName(p: HuddleParticipantView): { name: string; label: string } {
  const { memberById } = useWorkspace();
  const name = memberById[p.identity]?.full_name || p.name || "Guest";
  return { name, label: p.isLocal ? `${name} (you)` : name };
}

/** Visible name followed by a muted "(you)" chip for the local participant. */
export function NameWithYou({ name, isLocal, className }: { name: string; isLocal: boolean; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1", className)}>
      <span className="truncate">{name}</span>
      {isLocal && <span className="shrink-0 opacity-70">(you)</span>}
    </span>
  );
}

/** Track the intrinsic size of a <video>, so overlays can match the picture exactly. */
function useVideoAspect(): [(el: HTMLVideoElement | null) => void, number] {
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    if (!el) return;
    const read = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) setAspect(el.videoWidth / el.videoHeight);
    };
    read();
    el.addEventListener("loadedmetadata", read);
    el.addEventListener("resize", read);
    return () => {
      el.removeEventListener("loadedmetadata", read);
      el.removeEventListener("resize", read);
    };
  }, [el]);
  return [setEl, aspect];
}

/**
 * Screen-share stage tile. The picture is fitted (never cropped) inside the tile, and
 * `children` render in a box that exactly covers the visible picture, so annotation overlays
 * line up across different screen sizes.
 */
export function ScreenTile({
  p,
  className,
  children,
  badge = true,
}: {
  p: HuddleParticipantView;
  className?: string;
  children?: React.ReactNode;
  badge?: boolean;
}) {
  const { name } = useParticipantName(p);
  const [videoRef, aspect] = useVideoAspect();
  if (!p.screenTrack) return null;
  return (
    <div
      role="listitem"
      aria-label={p.isLocal ? "Your screen" : `${name}'s screen`}
      className={cn("relative overflow-hidden rounded-2xl bg-black/80 ring-1 ring-white/10", className)}
      style={{ containerType: "size" }}
    >
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ aspectRatio: String(aspect), width: `min(100cqw, calc(100cqh * ${aspect.toFixed(5)}))` }}
      >
        <VideoView ref={videoRef} track={p.screenTrack} fit="contain" className="bg-transparent" />
        {children}
      </div>
      {badge && (
        <span className="pointer-events-none absolute top-2 left-2 z-10 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white ring-1 ring-white/10 backdrop-blur">
          <ScreenShare className="size-3.5 shrink-0 text-emerald-300" aria-hidden />
          <span className="truncate">{p.isLocal ? "Your screen" : `${name}'s screen`}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Tile for the call window stage (always on a dark surface). Camera video when it's on,
 * otherwise the person's avatar scaled to the tile (via container queries) on a soft gradient
 * of their colour. Shows the speaking ring, name, muted mic, raised hand and poor connection.
 */
export function StageTile({
  p,
  hand,
  pinned,
  onTogglePin,
  variant = "grid",
  className,
  style,
}: {
  p: HuddleParticipantView;
  hand?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  variant?: "grid" | "spotlight" | "film";
  className?: string;
  style?: React.CSSProperties;
}) {
  const { name, label } = useParticipantName(p);
  const hue = hueFor(p.identity);
  const poor = p.quality === ConnectionQuality.Poor || p.quality === ConnectionQuality.Lost;
  const film = variant === "film";
  return (
    <div
      role="listitem"
      aria-label={`${label}${p.micEnabled ? "" : ", muted"}${p.speaking ? ", speaking" : ""}${hand ? ", hand raised" : ""}${pinned ? ", pinned" : ""}`}
      style={style}
      className={cn(
        "group/tile @container relative isolate overflow-hidden bg-zinc-900 ring-1 ring-white/10 transition-[box-shadow] duration-200",
        film ? "rounded-xl" : "rounded-2xl",
        p.speaking && "ring-2 ring-emerald-400 shadow-[0_0_0_4px_rgb(52_211_153/0.22)]",
        className,
      )}
    >
      {p.cameraTrack ? (
        <CameraView track={p.cameraTrack} isLocal={p.isLocal} />
      ) : (
        <div
          className="flex size-full items-center justify-center"
          style={{
            background: `radial-gradient(120% 90% at 50% 38%, hsl(${hue} 55% 42% / 0.45), transparent 62%), linear-gradient(160deg, hsl(${hue} 22% 17%), hsl(${hue} 18% 9%))`,
          }}
        >
          <span className="relative flex items-center justify-center">
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 rounded-[24%] bg-emerald-400/30 transition-[transform,opacity] duration-300 ease-out",
                p.speaking ? "scale-[1.22] opacity-100" : "scale-100 opacity-0",
              )}
            />
            <UserAvatar
              id={p.identity}
              name={name}
              size="xl"
              className={cn(
                "relative [&>span]:rounded-[24%] [&>span]:shadow-[0_8px_30px_-6px_rgb(0_0_0/0.6)]",
                film
                  ? "[&>span]:size-[clamp(28px,38cqmin,56px)] [&>span]:text-[clamp(11px,14cqmin,20px)]"
                  : "[&>span]:size-[clamp(44px,30cqmin,136px)] [&>span]:text-[clamp(16px,11cqmin,50px)]",
              )}
            />
          </span>
        </div>
      )}

      {/* Bottom scrim keeps the label readable over bright video. */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/45 to-transparent" />

      <span
        className={cn(
          "absolute left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/55 font-medium text-white backdrop-blur",
          film ? "bottom-1.5 left-1.5 px-1.5 py-0.5 text-[11px]" : "bottom-2 px-2 py-1 text-xs",
        )}
      >
        {!p.micEnabled && <MicOff className="size-3 shrink-0 text-red-300" aria-label="Muted" />}
        <NameWithYou name={name} isLocal={p.isLocal} />
      </span>

      {hand && (
        <span
          className={cn(
            "absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-amber-400 font-semibold text-amber-950 shadow-md animate-in zoom-in-75 fade-in-0 duration-200",
            film ? "size-6 justify-center" : "px-2 py-1 text-xs",
          )}
        >
          <Hand className={film ? "size-3.5" : "size-3.5"} aria-hidden />
          {!film && <span>Hand raised</span>}
        </span>
      )}

      {poor && (
        <span
          role="img"
          aria-label="Poor connection"
          title="Poor connection"
          className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-amber-300 group-hover/tile:opacity-0 group-focus-within/tile:opacity-0"
        >
          <SignalLow className="size-3.5" aria-hidden />
        </span>
      )}

      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
          title={pinned ? "Unpin" : "Pin to spotlight"}
          className={cn(
            "absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 outline-none backdrop-blur transition-opacity hover:bg-black/80 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70 group-hover/tile:opacity-100 [@media(hover:none)]:opacity-100",
            pinned && "opacity-100",
          )}
        >
          {pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
        </button>
      )}
    </div>
  );
}
