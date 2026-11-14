"use client";

import { Archive, ArchiveRestore, Check, MoreHorizontal, ShieldCheck, ShieldOff, UserMinus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AIAvatar } from "@/components/ai/brand";
import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  agentInstalledIn,
  viewerCan,
  useWorkspaceAIStatus,
  useWorkspaceSettings,
  type ChannelRole,
  type ChannelRoles,
} from "@/lib/admin";
import type { Channel } from "@/lib/api";
import { toast } from "@/lib/toast";

import { setAgentInChannel } from "./apps-tab";
import { SkeletonBlock, Spinner } from "./controls";

/* ------------------------------------------------------------ roles */

/**
 * Channel roles for the details dialog (GET /channels/{id}/roles). Until it loads, workspace admins
 * already get manager powers; everyone else waits for the server's answer.
 */
export function useChannelRoles(channelId: string, memberIds: string[]) {
  const ws = useWorkspace();
  const key = `${channelId}|${memberIds.join(",")}`;
  const [data, setData] = useState<{ key: string; roles: ChannelRoles | null } | null>(null);

  useEffect(() => {
    let live = true;
    adminApi
      .channelRoles(channelId)
      .then((roles) => live && setData({ key, roles }))
      .catch(() => live && setData({ key, roles: null }));
    return () => {
      live = false;
    };
  }, [channelId, key]);

  const info = data?.roles ?? null;
  const managers = new Set(info?.manager_ids ?? []);
  const roles: Record<string, ChannelRole> | null = info
    ? Object.fromEntries(memberIds.map((id) => [id, managers.has(id) ? "manager" : "member"]))
    : null;
  const myRole: ChannelRole | null = ws.me && info ? (managers.has(ws.me.id) ? "manager" : "member") : null;
  const canManage = info ? info.can_manage : ws.isAdmin;
  const canArchive = info ? info.can_archive : false;

  const setRole = async (userId: string, role: ChannelRole) => {
    const patch = (fn: (ids: string[]) => string[]) =>
      setData((d) => (d && d.roles ? { ...d, roles: { ...d.roles, manager_ids: fn(d.roles.manager_ids) } } : d));
    const wasManager = managers.has(userId);
    patch((ids) => (role === "manager" ? Array.from(new Set([...ids, userId])) : ids.filter((x) => x !== userId)));
    try {
      await adminApi.setChannelRole(channelId, userId, role);
    } catch (err) {
      patch((ids) => (wasManager ? Array.from(new Set([...ids, userId])) : ids.filter((x) => x !== userId)));
      throw err;
    }
  };

  return { roles, myRole, canManage, canArchive, setRole };
}

/** "…" menu on a channel member row for managers/admins. */
export function ChannelMemberActions({
  channel,
  userId,
  name,
  role,
  rolesKnown,
  onSetRole,
  onRemoved,
}: {
  channel: Channel;
  userId: string;
  name: string;
  role: ChannelRole;
  rolesKnown: boolean;
  onSetRole: (userId: string, role: ChannelRole) => Promise<void>;
  onRemoved: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const isGeneral = channel.name === "general";

  const toggleManager = async () => {
    const next: ChannelRole = role === "manager" ? "member" : "manager";
    try {
      await onSetRole(userId, next);
      toast.success(next === "manager" ? `${name} is now a channel manager` : `${name} is no longer a channel manager`);
    } catch (err) {
      toast.error(adminErrorMessage(err, "Couldn't change the channel role"));
    }
  };

  const remove = async () => {
    try {
      await adminApi.removeChannelMember(channel.id, userId);
    } catch (err) {
      throw new Error(adminErrorMessage(err, "Couldn't remove this person"));
    }
    toast.success(`${name} was removed from #${channel.name}`);
    onRemoved();
  };

  if (!rolesKnown && isGeneral) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Manage ${name}`}
          className="mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-popup-open:bg-muted"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {rolesKnown && (
            <DropdownMenuItem onClick={toggleManager}>
              {role === "manager" ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
              {role === "manager" ? "Remove as channel manager" : "Make channel manager"}
            </DropdownMenuItem>
          )}
          {!isGeneral && (
            <>
              {rolesKnown && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
                <UserMinus className="size-4" /> Remove from channel
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${name} from #${channel.name}?`}
        description={
          channel.kind === "private"
            ? `${name} will lose access to #${channel.name} and needs an invite to come back.`
            : `${name} can rejoin #${channel.name} any time since it's public.`
        }
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

/* ------------------------------------------------------------ settings */

export function ChannelSettingsPanel({
  channel,
  canManage,
  canArchive,
  onArchived,
}: {
  channel: Channel;
  canManage: boolean;
  /** Server-computed (GET /channels/{id}/roles): manager/admin and the archive_channels policy allows it. */
  canArchive: boolean;
  onArchived?: () => void;
}) {
  const ws = useWorkspace();
  const [name, setName] = useState(channel.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"archive" | "unarchive" | null>(null);
  const isGeneral = channel.name === "general";
  const nameValid = /^[a-z0-9][a-z0-9_-]{0,79}$/.test(name);
  const dirty = name !== channel.name;

  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !nameValid || saving) return;
    setSaving(true);
    setError("");
    try {
      await adminApi.renameChannel(channel.id, name);
      await ws.reloadChannels();
      toast.success(`Channel renamed to #${name}`);
    } catch (err) {
      setError(adminErrorMessage(err, "Couldn't rename the channel"));
    } finally {
      setSaving(false);
    }
  };

  const setArchived = async (archive: boolean) => {
    try {
      await (archive ? adminApi.archiveChannel(channel.id) : adminApi.unarchiveChannel(channel.id));
    } catch (err) {
      throw new Error(adminErrorMessage(err, archive ? "Couldn't archive the channel" : "Couldn't unarchive the channel"));
    }
    await ws.reloadChannels().catch(() => {});
    toast.success(archive ? `#${channel.name} was archived` : `#${channel.name} was restored`);
    if (archive) onArchived?.();
  };

  return (
    <div className="space-y-4">
      {!canManage && (
        <p className="rounded-lg border bg-background p-3 text-sm text-muted-foreground">
          Only channel managers and workspace admins can change these settings.
        </p>
      )}
      <form onSubmit={rename} className="rounded-lg border bg-background p-4">
        <label htmlFor="channel-rename" className="text-sm font-bold">
          Channel name
        </label>
        <p className="text-xs text-muted-foreground">
          {isGeneral ? "#general can't be renamed." : "Lowercase letters, numbers, dashes and underscores."}
        </p>
        <div className="mt-2 flex gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
            <span className="pl-2.5 text-sm text-muted-foreground" aria-hidden>
              #
            </span>
            <Input
              id="channel-rename"
              value={name}
              disabled={!canManage || isGeneral || channel.is_archived}
              maxLength={80}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, ""))}
              aria-invalid={dirty && !nameValid}
              className="border-0 bg-transparent pl-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {canManage && !isGeneral && (
            <Button type="submit" disabled={!dirty || !nameValid || saving} className="bg-send text-white hover:bg-send/90">
              {saving ? <Spinner /> : <Check />}
              Save
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>

      {!isGeneral && (
        <div className="rounded-lg border bg-background p-4">
          <p className="text-sm font-bold">{channel.is_archived ? "Restore this channel" : "Archive this channel"}</p>
          <p className="text-xs text-muted-foreground">
            {channel.is_archived
              ? "Unarchiving lets people post here again. Members and history are kept."
              : "Archived channels are read-only and hidden from the sidebar. Messages and files stay searchable."}
          </p>
          {canArchive ? (
            <Button
              variant={channel.is_archived ? "outline" : "destructive"}
              className="mt-3"
              onClick={() => setConfirm(channel.is_archived ? "unarchive" : "archive")}
            >
              {channel.is_archived ? <ArchiveRestore /> : <Archive />}
              {channel.is_archived ? "Unarchive channel" : "Archive channel"}
            </Button>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {canManage ? "An admin has limited archiving to workspace admins." : "Only managers and admins can archive."}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "archive" ? `Archive #${channel.name}?` : `Unarchive #${channel.name}?`}
        description={
          confirm === "archive"
            ? "Nobody will be able to post. You can unarchive it later from channel settings."
            : "Members will be able to post again."
        }
        confirmLabel={confirm === "archive" ? "Archive" : "Unarchive"}
        destructive={confirm === "archive"}
        onConfirm={() => setArchived(confirm === "archive")}
      />
    </div>
  );
}

/* ------------------------------------------------------------ integrations */

export function ChannelIntegrationsPanel({ channel }: { channel: Channel }) {
  const ws = useWorkspace();
  const { status, error, reload } = useWorkspaceAIStatus(ws.workspaceId);
  const { settings } = useWorkspaceSettings(ws.workspaceId);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const myWsRole = (ws.me && ws.memberById[ws.me.id]?.role) || "member";
  const policyOk = viewerCan(settings, "install_apps", myWsRole);
  const canInstall = channel.is_member && !channel.is_archived && policyOk;
  const { installed, viaEverywhere } = agentInstalledIn(status, channel);
  const settingsHref = `/w/${ws.workspaceId}/settings?tab=apps`;

  const toggle = async (install: boolean) => {
    setBusy(true);
    try {
      await setAgentInChannel(ws.workspaceId, channel.id, install);
      toast.success(install ? `Worklio AI added to #${channel.name}` : `Worklio AI removed from #${channel.name}`);
    } catch (err) {
      const msg = adminErrorMessage(err);
      if (install) toast.error(msg);
      else throw new Error(msg);
    } finally {
      setBusy(false);
    }
  };

  const reason = !channel.is_member
    ? "Join the channel to add apps."
    : channel.is_archived
      ? "Archived channels can't get new apps."
      : !canInstall
        ? "An admin has limited adding apps to workspace admins."
        : null;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-background">
        <div className="flex items-start gap-3 p-4">
          <AIAvatar className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-bold">Worklio AI</p>
              {status && installed && (
                <span className="rounded-full bg-emerald-500/15 px-2 text-[11px] leading-5 font-bold text-emerald-700 dark:text-emerald-300">
                  {viaEverywhere ? "Added to all public channels" : "Added"}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Mention <span className="font-semibold text-foreground">@worklio</span> to ask questions about this channel, get summaries,
              draft replies and create tasks.
            </p>
          </div>
        </div>
        <div className="border-t px-4 py-3">
          {error && !status ? (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-destructive">{error}</span>
              <Button size="sm" variant="outline" onClick={() => reload().catch(() => {})}>
                Retry
              </Button>
            </div>
          ) : !status ? (
            <SkeletonBlock rows={1} />
          ) : !status.enabled ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Worklio AI isn&apos;t set up for this workspace yet.</span>
              {status.can_configure ? (
                <Button size="sm" variant="outline" render={<Link href={`/w/${ws.workspaceId}/settings?tab=ai`} />} nativeButton={false}>
                  Set up AI
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Ask a workspace admin to turn it on.</span>
              )}
            </div>
          ) : viaEverywhere ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">An admin added Worklio AI to every public channel.</span>
              {ws.isAdmin && (
                <Link href={settingsHref} className="text-sm font-semibold text-link hover:underline">
                  Manage in Settings → Apps
                </Link>
              )}
            </div>
          ) : installed ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Active in #{channel.name}.</span>
              {canInstall && (
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  {busy && <Spinner className="size-3.5" />}
                  Remove from channel
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{reason ?? "Not added to this channel yet."}</span>
              <Button size="sm" className="bg-send text-white hover:bg-send/90" disabled={busy || !!reason} onClick={() => toggle(true)}>
                {busy && <Spinner className="size-3.5" />}
                Add to channel
              </Button>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove Worklio AI from #${channel.name}?`}
        description="@worklio will stop replying here. You can add it back any time."
        confirmLabel="Remove"
        destructive
        onConfirm={() => toggle(false)}
      />
    </div>
  );
}
