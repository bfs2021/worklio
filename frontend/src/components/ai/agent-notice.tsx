"use client";

import { EyeOff, Loader2, Plus } from "lucide-react";

import { AGENT_ADD_HINT, AISparkle, useWorklioAgent } from "@/components/ai/composer-assistant";
import type { Message } from "@/lib/api";

/** System messages the Worklio agent posts about its own installs (Wave D1). */
const AGENT_NOTICE_TYPES = new Set(["ai_agent_not_installed", "ai_agent_installed", "ai_agent_uninstalled"]);

export function isAgentNotice(m: Pick<Message, "kind" | "meta">): boolean {
  return m.kind === "system" && typeof m.meta?.type === "string" && AGENT_NOTICE_TYPES.has(m.meta.type);
}

/**
 * Ephemeral-style system messages (`meta.ephemeral` + `meta.visible_to`) are stored in the channel
 * but shown only to the people they're meant for, e.g. "Worklio AI isn't added to #x" goes to the asker.
 */
export function isHiddenEphemeral(m: Pick<Message, "kind" | "meta">, meId: string | null | undefined): boolean {
  if (m.kind !== "system" || m.meta?.ephemeral !== true) return false;
  const to = m.meta.visible_to;
  if (!Array.isArray(to)) return false;
  return !meId || !to.includes(meId);
}

/** Card for agent install notices: an "Only visible to you" hint with a one-click Add, or a quiet status line. */
export function AgentNotice({ message: m }: { message: Message }) {
  if (m.meta?.type === "ai_agent_not_installed") return <NotInstalledNotice message={m} />;
  const added = m.meta?.type === "ai_agent_installed";
  return (
    <div className="text-msg mt-0.5 flex items-center gap-1.5 text-muted-foreground">
      <AISparkle className="size-4 rounded" iconClassName="size-2.5" />
      <span className="min-w-0 break-words">
        {m.body || (added ? "Worklio AI was added to this channel" : "Worklio AI was removed from this channel")}
      </span>
    </div>
  );
}

function NotInstalledNotice({ message: m }: { message: Message }) {
  const agent = useWorklioAgent(m.channel_id);
  return (
    <div
      role="note"
      className="mt-1 flex max-w-xl flex-col gap-2 rounded-lg bg-violet-500/[0.06] px-3 py-2.5 ring-1 ring-violet-500/20 ring-inset dark:bg-violet-400/[0.08]"
    >
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground">
        <EyeOff className="size-3.5" aria-hidden />
        Only visible to you
      </p>
      <p className="text-msg break-words">{m.body}</p>
      {agent.installed ? (
        <p className="text-xs text-muted-foreground">Worklio AI has since been added. Mention @Worklio again.</p>
      ) : agent.canAdd && agent.available ? (
        <div>
          <button
            type="button"
            onClick={() => void agent.add()}
            disabled={agent.adding}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-linear-to-r from-violet-600 to-indigo-600 px-3 text-xs font-semibold text-white shadow-sm outline-none hover:from-violet-500 hover:to-indigo-500 focus-visible:ring-2 focus-visible:ring-violet-500/50 disabled:opacity-60"
          >
            {agent.adding ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
            {agent.adding ? "Adding…" : `Add Worklio AI to #${agent.channelName}`}
          </button>
        </div>
      ) : !agent.canAdd ? (
        <p className="text-xs text-muted-foreground">{AGENT_ADD_HINT}</p>
      ) : null}
    </div>
  );
}
