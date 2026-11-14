"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import type { AICitation } from "@/lib/ai";
import type { Message } from "@/lib/api";
import { cn } from "@/lib/utils";

import { AIMarkdown } from "./ai-markdown";
import { AISparkle } from "./brand";
import { CitationList, useJumpToCitation } from "./citations";
import { useIsBotUser } from "./composer-assistant";

/**
 * The @worklio agent's replies (meta.type === "ai_agent"): markdown with [n] citation chips,
 * a collapsible source list and the "AI can make mistakes" footer.
 */
export function isAgentMessage(m: Pick<Message, "meta">): boolean {
  return m.meta?.type === "ai_agent";
}

function citationsOf(m: Message): AICitation[] {
  const raw = m.meta?.citations;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is AICitation =>
      !!c && typeof c === "object" && typeof (c as AICitation).n === "number" && typeof (c as AICitation).message_id === "string",
  );
}

export function AgentAnswer({ message }: { message: Message }) {
  const jump = useJumpToCitation();
  const citations = citationsOf(message);
  const [showSources, setShowSources] = useState(false);
  return (
    <div className="min-w-0 whitespace-normal">
      <AIMarkdown text={message.body} citations={citations} onCite={jump} className="text-msg" />
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {citations.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSources((s) => !s)}
            aria-expanded={showSources}
            className="inline-flex items-center gap-1 font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            {citations.length} source{citations.length === 1 ? "" : "s"}
            <ChevronDown className={cn("size-3 transition-transform", showSources && "rotate-180")} />
          </button>
        )}
        <span className="inline-flex items-center gap-1">
          <AISparkle className="size-3 text-muted-foreground" /> Worklio AI can make mistakes.
        </span>
      </div>
      {showSources && <CitationList citations={citations} onJump={jump} className="mt-1.5 max-w-xl" />}
    </div>
  );
}

type Working = { key: string; text: string | null };
const IDLE_MS = 7000;

/**
 * "✨ Worklio is working… Searching messages…" under the composer while the @worklio agent replies.
 * Channel composers (no parentId) show work on top-level replies (DMs); thread composers show work
 * on replies in that thread. Bot typing is refreshed every 2.5 s; the line clears when the bot posts
 * or goes quiet.
 */
export function useAgentWorking(channelId: string, parentId?: string | null): string | null {
  const isBot = useIsBotUser();
  const isBotRef = useRef(isBot);
  useEffect(() => {
    isBotRef.current = isBot;
  });
  const [working, setWorking] = useState<Record<string, Working>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  const clear = (ch: string) => {
    clearTimeout(timers.current[ch]);
    delete timers.current[ch];
    setWorking((w) => {
      if (!w[ch]) return w;
      const next = { ...w };
      delete next[ch];
      return next;
    });
  };
  const touch = (ch: string, patch: Partial<Working>) => {
    clearTimeout(timers.current[ch]);
    timers.current[ch] = setTimeout(() => clear(ch), IDLE_MS);
    setWorking((w) => ({ ...w, [ch]: { key: w[ch]?.key ?? "", text: w[ch]?.text ?? null, ...patch } }));
  };

  useWorkspaceEvents((e) => {
    if (e.type === "typing" && isBotRef.current(e.user_id)) touch(e.channel_id, { key: e.parent_id ?? "" });
    else if (e.type === "ai.agent_status") touch(e.channel_id, { text: e.text });
    else if (e.type === "message.created" && isBotRef.current(e.message.author_id)) clear(e.message.channel_id);
  });

  const w = working[channelId];
  if (!w || w.key !== (parentId ?? "")) return null;
  return w.text ?? "Thinking…";
}

export function AgentWorkingLine({ status }: { status: string }) {
  const { workspace } = useWorkspace();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={workspace ? `Worklio AI in ${workspace.name}` : undefined}>
      <span className="flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-gradient-to-br from-violet-400 to-indigo-500">
        <AISparkle className="size-2.5 animate-pulse text-white dark:text-white" />
      </span>
      <strong className="bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent dark:from-violet-300 dark:to-indigo-300">
        Worklio
      </strong>
      <span className="truncate">is working · {status}</span>
    </span>
  );
}
