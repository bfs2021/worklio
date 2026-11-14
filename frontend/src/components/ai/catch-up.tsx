"use client";

import { X } from "lucide-react";
import Link from "next/link";

import { ChannelIcon } from "@/components/views/message-snippet";
import { useWorkspace } from "@/components/workspace/provider";
import { aiPaths, useAIGate, type AICitation } from "@/lib/ai";
import { cn } from "@/lib/utils";

import { AIDisabledState, AILabel, AISparkle, AI_RING, AI_SURFACE } from "./brand";
import { StreamedAnswer } from "./streamed-answer";

/** "✨ Catch me up" button for the Unreads header. */
export function CatchUpButton({ onClick, active, disabled }: { onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title="Get an AI digest of your unread conversations"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold text-white shadow-sm shadow-violet-500/25 transition-all disabled:pointer-events-none disabled:opacity-50",
        "bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500",
      )}
    >
      <AISparkle className="size-3.5 text-white dark:text-white" />
      <span className="hidden sm:inline">Catch me up</span>
      <span className="sm:hidden">Catch up</span>
    </button>
  );
}

/** Channels the digest cites, in order of first appearance: quick jump links. */
function ChannelJumps({ citations }: { citations: AICitation[] }) {
  const ws = useWorkspace();
  const seen = new Map<string, number>();
  for (const c of citations) seen.set(c.channel_id, (seen.get(c.channel_id) ?? 0) + 1);
  if (!seen.size) return null;
  return (
    <div className="mb-1 flex w-full flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">Jump to</span>
      {[...seen.keys()].map((id) => {
        const channel = ws.channels.find((c) => c.id === id);
        return (
          <Link
            key={id}
            href={`/w/${ws.workspaceId}/c/${id}`}
            className="inline-flex max-w-48 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs font-semibold hover:border-violet-500/40 hover:bg-violet-500/[0.05]"
          >
            <ChannelIcon channel={channel} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{channel ? ws.channelLabel(channel) : "conversation"}</span>
          </Link>
        );
      })}
    </div>
  );
}

/** Streaming digest across my unread conversations, grouped by channel. */
export function CatchUpCard({ onClose, className }: { onClose: () => void; className?: string }) {
  const ws = useWorkspace();
  const gate = useAIGate("summaries");
  return (
    <section aria-label="Catch me up" className={cn("overflow-hidden rounded-xl border bg-background shadow-xs", AI_RING, className)}>
      <header className={cn("flex items-center gap-2 border-b px-3 py-2", AI_SURFACE)}>
        <AILabel>Catch me up</AILabel>
        <span className="hidden text-xs text-muted-foreground sm:inline">Your unread conversations, most important first</span>
        <button
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close digest"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="p-3 sm:p-4">
        {gate.reason ? (
          <AIDisabledState feature="summaries" />
        ) : (
          <StreamedAnswer
            path={aiPaths.catchUp(ws.workspaceId)}
            body={{}}
            thinking="Reading your unread conversations…"
            empty="You're all caught up. Nothing unread to digest."
            linkChannels
            feature="summaries"
            actions={(s) => (!s.error && s.citations.length ? <ChannelJumps citations={s.citations} /> : null)}
          />
        )}
      </div>
    </section>
  );
}
