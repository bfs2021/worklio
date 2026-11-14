"use client";

import { AlertTriangle, Hash, Lock, Search } from "lucide-react";
import { useState } from "react";

import { AIAvatar } from "@/components/ai/brand";
import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBlock } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  agentInstalledIn,
  aiStatusStore,
  notifyAIChanged,
  useWorkspaceAIStatus,
  type WorkspaceAIStatus,
} from "@/lib/admin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { Section, SkeletonBlock, Spinner, Switch } from "./controls";

/** Optimistically patch the shared AI status, returning a rollback. */
function patchStatus(ws: string, fn: (s: WorkspaceAIStatus) => WorkspaceAIStatus): () => void {
  const prev = aiStatusStore.get(ws).data;
  aiStatusStore.set(ws, (s) => (s ? fn(s) : s));
  return () => aiStatusStore.set(ws, () => prev);
}

export async function setAgentInChannel(ws: string, channelId: string, install: boolean) {
  const rollback = patchStatus(ws, (s) => ({
    ...s,
    agent_installed_channel_ids: install
      ? Array.from(new Set([...s.agent_installed_channel_ids, channelId]))
      : s.agent_installed_channel_ids.filter((id) => id !== channelId),
  }));
  try {
    await (install ? adminApi.installAgent(channelId) : adminApi.uninstallAgent(channelId));
    notifyAIChanged(ws);
  } catch (err) {
    rollback();
    throw new Error(adminErrorMessage(err, install ? "Couldn't add Worklio AI" : "Couldn't remove Worklio AI"));
  }
}

export function AppsTab({ onOpenAI }: { onOpenAI: () => void }) {
  const ws = useWorkspace();
  const { status, error, reload } = useWorkspaceAIStatus(ws.workspaceId);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const channels = ws.channels
    .filter((c) => c.kind !== "dm" && !c.is_archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = channels.filter((c) => c.name.includes(filter.trim().toLowerCase()));

  const setEverywhere = async (on: boolean) => {
    const rollback = patchStatus(ws.workspaceId, (s) => ({ ...s, agent_installed_everywhere: on }));
    try {
      await (on ? adminApi.installEverywhere(ws.workspaceId) : adminApi.uninstallEverywhere(ws.workspaceId));
      notifyAIChanged(ws.workspaceId);
      toast.success(on ? "Worklio AI added to all public channels" : "Worklio AI removed from the all-channels install");
    } catch (err) {
      rollback();
      const msg = adminErrorMessage(err, "Couldn't update the install");
      toast.error(msg);
      throw new Error(msg);
    }
  };

  const toggleChannel = async (channelId: string, name: string, install: boolean) => {
    setBusy(channelId);
    try {
      await setAgentInChannel(ws.workspaceId, channelId, install);
      toast.success(install ? `Worklio AI added to #${name}` : `Worklio AI removed from #${name}`);
    } catch (err) {
      toast.error(adminErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (error && !status) return <ErrorBlock message={error} onRetry={() => reload().catch(() => {})} />;
  if (!status) return <SkeletonBlock rows={5} />;

  const installedCount = channels.filter((c) => agentInstalledIn(status, c).installed).length;

  return (
    <div className="space-y-4 sm:space-y-6">
      <Section
        title={
          <span className="flex items-center gap-2.5">
            <AIAvatar className="size-7" /> Worklio AI
          </span>
        }
        description="An @worklio teammate that answers questions, summarizes threads and does tasks in the channels it's added to. DMs with Worklio always work when AI is on."
      >
        {!status.enabled && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 flex-1">AI isn&apos;t set up yet, so the app won&apos;t reply until a provider and API key are configured.</span>
            <Button size="sm" variant="outline" onClick={onOpenAI}>
              Set up AI
            </Button>
          </div>
        )}
        {status.enabled && status.features && status.features.agent === false && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">The @worklio agent feature is turned off in AI settings.</span>
            <Button size="sm" variant="outline" onClick={onOpenAI}>
              Open AI settings
            </Button>
          </div>
        )}
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="agent-everywhere" className="text-sm font-bold">
              Add to all public channels
            </label>
            <p className="text-xs text-muted-foreground">
              Covers every current and future public channel. Private channels are added one at a time below.
            </p>
          </div>
          <Switch
            id="agent-everywhere"
            checked={status.agent_installed_everywhere}
            onCheckedChange={(on) => (on ? setEverywhere(true).catch(() => {}) : setConfirmOff(true))}
          />
        </div>
      </Section>

      <Section
        title={`Channels · ${installedCount} with Worklio AI`}
        description="Add or remove the app per channel. Channel managers can also do this from Channel details → Integrations."
      >
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a channel" aria-label="Find a channel" className="pl-8" />
        </div>
        <ul className="-mx-4 -mb-4 divide-y border-t sm:-mx-5">
          {visible.length === 0 && <li className="px-5 py-6 text-center text-sm text-muted-foreground">No channels match.</li>}
          {visible.map((c) => {
            const { installed, viaEverywhere } = agentInstalledIn(status, c);
            const Icon = c.kind === "private" ? Lock : Hash;
            return (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.name}</span>
                {installed && (
                  <span
                    className={cn(
                      "hidden shrink-0 rounded-full px-2 text-[11px] leading-5 font-bold sm:inline",
                      viaEverywhere ? "bg-muted text-muted-foreground" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {viaEverywhere ? "All public channels" : "Added"}
                  </span>
                )}
                {viaEverywhere ? (
                  <span className="w-20 shrink-0 text-right text-xs text-muted-foreground sm:hidden">Added</span>
                ) : (
                  <Button
                    size="sm"
                    variant={installed ? "ghost" : "outline"}
                    className={cn("w-20 shrink-0", installed && "text-destructive hover:text-destructive")}
                    disabled={busy === c.id}
                    onClick={() => toggleChannel(c.id, c.name, !installed)}
                    aria-label={installed ? `Remove Worklio AI from ${c.name}` : `Add Worklio AI to ${c.name}`}
                  >
                    {busy === c.id ? <Spinner className="size-3.5" /> : installed ? "Remove" : "Add"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Remove Worklio AI from all public channels?"
        description="It stays in channels where it was added individually. Mentions elsewhere get a short note on how to add it."
        confirmLabel="Remove"
        destructive
        onConfirm={() => setEverywhere(false)}
      />
    </div>
  );
}
