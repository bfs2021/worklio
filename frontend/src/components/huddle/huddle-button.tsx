"use client";

import { Headphones, LoaderCircle } from "lucide-react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { useHuddleRoom, useHuddles } from "./huddle-provider";

/** Header button: "Huddle" → "Join · avatars + count" → "Leave". */
export function HuddleButton({ channelId, className }: { channelId: string; className?: string }) {
  const { huddles, activeChannelId, status, join, leave } = useHuddles();
  const { channels, memberById } = useWorkspace();

  const channel = channels.find((c) => c.id === channelId);
  const archived = channel?.is_archived ?? false;
  const inThis = activeChannelId === channelId;
  const participants = huddles[channelId]?.participant_ids ?? [];

  if (inThis) {
    const connecting = status === "connecting";
    return (
      <Button
        size="sm"
        onClick={leave}
        aria-label={connecting ? "Cancel joining huddle" : "Leave huddle"}
        className={cn(
          "gap-1.5 rounded-full bg-emerald-600 pr-3 text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500",
          className,
        )}
      >
        {connecting ? <LoaderCircle className="animate-spin" aria-hidden /> : <LiveHeadphones />}
        <span>{connecting ? "Joining…" : "Leave"}</span>
      </Button>
    );
  }

  if (participants.length) {
    const shown = participants.slice(0, 3);
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={archived}
        onClick={() => void join(channelId)}
        aria-label={`Join huddle with ${participants.length} ${participants.length === 1 ? "person" : "people"}`}
        className={cn(
          "gap-1.5 rounded-full border-emerald-500/50 bg-emerald-500/10 pr-3 pl-1.5 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-200 dark:hover:bg-emerald-400/20",
          className,
        )}
      >
        <span className="flex -space-x-1.5" aria-hidden>
          {shown.map((id) => (
            <UserAvatar
              key={id}
              id={id}
              name={memberById[id]?.full_name ?? "?"}
              size="sm"
              className="rounded-[5px] ring-2 ring-background"
            />
          ))}
        </span>
        <Headphones aria-hidden />
        <span className="tabular-nums">{participants.length}</span>
        <span className="hidden sm:inline">· Join</span>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={archived}
      onClick={() => void join(channelId)}
      aria-label="Start a huddle"
      title={archived ? "This channel is archived" : "Start a huddle"}
      className={cn("gap-1.5", className)}
    >
      <Headphones aria-hidden />
      <span className="hidden sm:inline">Huddle</span>
    </Button>
  );
}

/** Headphones icon that wiggles while someone in my huddle is speaking. */
function LiveHeadphones() {
  const { speakingIds } = useHuddleRoom();
  return speakingIds.length ? <SpeakingBars className="h-3.5" /> : <Headphones aria-hidden />;
}

const EQ_CSS = `
@keyframes worklio-huddle-eq { 0%,100% { transform: scaleY(.35) } 50% { transform: scaleY(1) } }
.worklio-huddle-eq > span { animation: worklio-huddle-eq .9s ease-in-out infinite; transform-origin: bottom; }
.worklio-huddle-eq > span:nth-child(2) { animation-delay: -.3s }
.worklio-huddle-eq > span:nth-child(3) { animation-delay: -.6s }
@media (prefers-reduced-motion: reduce) { .worklio-huddle-eq > span { animation: none; transform: scaleY(.7) } }
`;

/** Three animated "equalizer" bars. Inherits currentColor. */
export function SpeakingBars({ className }: { className?: string }) {
  return (
    <>
      <style href="worklio-huddle-eq" precedence="default">
        {EQ_CSS}
      </style>
      <span className={cn("worklio-huddle-eq inline-flex h-3 items-end gap-[2px]", className)} aria-hidden>
        <span className="h-full w-[3px] rounded-full bg-current" />
        <span className="h-full w-[3px] rounded-full bg-current" />
        <span className="h-full w-[3px] rounded-full bg-current" />
      </span>
    </>
  );
}
