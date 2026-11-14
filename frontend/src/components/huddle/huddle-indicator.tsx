"use client";

import { Headphones } from "lucide-react";

import { cn } from "@/lib/utils";

import { SpeakingBars } from "./huddle-button";
import { useHuddleRoom, useHuddles } from "./huddle-provider";

/**
 * Tiny live marker for a sidebar row: headphones + participant count.
 * Animates while someone speaks (known only for the huddle I'm in). Renders nothing when there's no huddle.
 */
export function HuddleIndicator({ channelId, className }: { channelId: string; className?: string }) {
  const { huddles, activeChannelId } = useHuddles();
  const { speakingIds } = useHuddleRoom();
  const count = huddles[channelId]?.participant_ids.length ?? 0;
  const mine = activeChannelId === channelId;
  if (!count && !mine) return null;

  const speaking = mine && speakingIds.length > 0;
  const label = `Huddle in progress, ${count} ${count === 1 ? "person" : "people"}${mine ? ", you're in it" : ""}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] leading-none font-semibold tabular-nums",
        // Solid fill so it reads on every sidebar theme (light lavender, aubergine, dark).
        mine
          ? "bg-emerald-500 text-white shadow-[0_0_0_2px_rgb(16_185_129/0.35)]"
          : "bg-emerald-600 text-white dark:bg-emerald-600/90",
        className,
      )}
    >
      {speaking ? <SpeakingBars className="h-2.5" /> : <Headphones className="size-2.5" aria-hidden />}
      {count > 0 && count}
    </span>
  );
}
