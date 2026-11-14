"use client";

import { Loader2, PenLine } from "lucide-react";
import dynamic from "next/dynamic";

import { cn } from "@/lib/utils";

import type { WhiteboardBoardProps } from "./whiteboard-board";

function BoardSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className={cn("flex shrink-0 items-center gap-2 border-b bg-background/95", compact ? "h-10 px-2" : "h-12 px-3 sm:px-4")}>
        <span
          className={cn(
            "grid shrink-0 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-sky-500 text-white",
            compact ? "size-6" : "size-7",
          )}
          aria-hidden
        >
          <PenLine className={compact ? "size-3.5" : "size-4"} />
        </span>
        <span className={cn("font-semibold tracking-tight", compact ? "text-[13px]" : "text-sm")}>Whiteboard</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:22px_22px]">
        <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-[13px] text-muted-foreground shadow-sm">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Loading whiteboard…
        </div>
      </div>
    </div>
  );
}

// Excalidraw touches window/document at import time: load it client-only.
const WhiteboardBoard = dynamic(() => import("./whiteboard-board"), {
  ssr: false,
  loading: () => <BoardSkeleton />,
});
const WhiteboardBoardCompact = dynamic(() => import("./whiteboard-board"), {
  ssr: false,
  loading: () => <BoardSkeleton compact />,
});

/** The channel's Whiteboard tab: a live, shared Excalidraw scene. Fills its (flex) parent. */
export function WhiteboardTab({ channelId, className }: { channelId: string; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 w-full flex-1 flex-col bg-background", className)}>
      <WhiteboardBoard channelId={channelId} />
    </div>
  );
}

/**
 * Embeddable whiteboard (e.g. the call window stage). Fills its parent completely; `compact`
 * swaps the header for a slim one. Pass `theme` to force light/dark instead of following the app.
 */
export function WhiteboardStage({
  channelId,
  compact = true,
  theme,
  className,
}: Pick<WhiteboardBoardProps, "channelId" | "compact" | "theme" | "className">) {
  const Board = compact ? WhiteboardBoardCompact : WhiteboardBoard;
  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground", className)}>
      <Board channelId={channelId} compact={compact} theme={theme} />
    </div>
  );
}
