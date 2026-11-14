"use client";

import { Hash, Lock, LogOut, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  ChannelIntegrationsPanel,
  ChannelMemberActions,
  ChannelSettingsPanel,
  useChannelRoles,
} from "@/components/admin/channel-admin";
import { RoleBadge } from "@/components/admin/controls";
import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { ProfilePopover } from "@/components/chat/profile-popover";
import { StatusEmoji } from "@/components/profile/status-emoji";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, type Channel } from "@/lib/api";
import { cn } from "@/lib/utils";

import { AddChannelMembersDialog } from "./dialogs";
import { useWorkspace } from "./provider";

export type DetailsTab = "about" | "members" | "integrations" | "settings";

const TAB_LABEL: Record<DetailsTab, string> = {
  about: "About",
  members: "Members",
  integrations: "Integrations",
  settings: "Settings",
};

export function ChannelDetailsDialog({
  channel,
  memberIds,
  open,
  tab,
  onOpenChange,
  onTabChange,
  onMembersChanged,
}: {
  channel: Channel;
  memberIds: string[];
  open: boolean;
  tab: DetailsTab;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: DetailsTab) => void;
  onMembersChanged: () => void;
}) {
  const ws = useWorkspace();
  const router = useRouter();
  const [editingTopic, setEditingTopic] = useState(false);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState("");
  const Icon = channel.kind === "private" ? Lock : Hash;
  const channelRoles = useChannelRoles(channel.id, memberIds);

  const saveTopic = async () => {
    setError("");
    try {
      await api(`/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ topic }) });
      setEditingTopic(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const [confirmLeave, setConfirmLeave] = useState(false);

  /** Throws on failure (ConfirmDialog shows the error inline). */
  const leaveChannel = async () => {
    await api(`/channels/${channel.id}/members/me`, { method: "DELETE" });
    await ws.reloadChannels();
    onOpenChange(false);
    router.push(`/w/${ws.workspaceId}`);
  };

  const leave = async () => {
    setError("");
    // Private channels need an invite to rejoin: confirm first.
    if (channel.kind === "private") return setConfirmLeave(true);
    try {
      await leaveChannel();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const members = memberIds
    .map((id) => ({ id, name: ws.memberById[id]?.full_name ?? "Unknown" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="flex min-w-0 items-center gap-1.5 pr-8 text-xl font-black">
            <Icon className="size-5 shrink-0" /> <span className="truncate">{channel.name}</span>
          </DialogTitle>
        </DialogHeader>
        <div role="tablist" aria-label="Channel details" className="mt-4 flex gap-4 overflow-x-auto border-b px-6 text-sm [scrollbar-width:none]">
          {(["about", "members", "integrations", "settings"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => onTabChange(t)}
              className={cn(
                "-mb-px shrink-0 border-b-2 pb-2 font-bold whitespace-nowrap",
                tab === t ? "border-tab text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "members" ? `Members ${memberIds.length}` : TAB_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-6">
          {tab === "about" ? (
            <div className="divide-y rounded-lg border bg-background">
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold">Topic</span>
                  {!editingTopic && (
                    <button
                      onClick={() => {
                        setTopic(channel.topic ?? "");
                        setEditingTopic(true);
                      }}
                      className="text-sm text-link hover:underline"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {editingTopic ? (
                  <div className="mt-2 space-y-2">
                    <Textarea value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} autoFocus />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingTopic(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" className="bg-send text-white hover:bg-send/90" onClick={saveTopic}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">{channel.topic || "Add a topic"}</p>
                )}
              </div>
              <div className="p-4 text-sm">
                <div className="font-bold">Created</div>
                <p className="text-muted-foreground">
                  {new Date(channel.created_at).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" })}
                </p>
              </div>
              {channel.name !== "general" && (
                <button onClick={leave} className="flex w-full items-center gap-2 p-4 text-sm font-bold text-destructive hover:bg-muted">
                  <LogOut className="size-4" /> Leave channel
                </button>
              )}
            </div>
          ) : tab === "members" ? (
            <div className="rounded-lg border bg-background">
              <button onClick={() => setAddOpen(true)} className="flex w-full items-center gap-3 border-b p-3 text-sm font-bold hover:bg-muted">
                <span className="flex size-9 items-center justify-center rounded-lg bg-mention text-mention-foreground">
                  <UserPlus className="size-4" />
                </span>
                Add people
              </button>
              {members.map((m) => {
                const isMe = m.id === ws.me?.id;
                const isBot = !!ws.memberById[m.id]?.is_bot;
                const role = channelRoles.roles?.[m.id] ?? "member";
                return (
                  <div key={m.id} className="flex items-center hover:bg-muted">
                    <ProfilePopover userId={m.id} className="block min-w-0 flex-1">
                      <span className="flex w-full items-center gap-3 p-3 text-sm">
                        <UserAvatar id={m.id} name={m.name} online={ws.online.has(m.id)} />
                        <span className="min-w-0 truncate font-bold">{m.name}</span>
                        <StatusEmoji userId={m.id} />
                        {isMe && <span className="text-muted-foreground">(you)</span>}
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {role === "manager" && <RoleBadge role="manager" />}
                          {ws.memberById[m.id]?.role === "guest" && <RoleBadge role="guest" />}
                          {isBot && <RoleBadge role="bot" />}
                        </span>
                      </span>
                    </ProfilePopover>
                    {channelRoles.canManage && !isMe && !isBot && (
                      <ChannelMemberActions
                        channel={channel}
                        userId={m.id}
                        name={m.name}
                        role={role}
                        rolesKnown={channelRoles.roles !== null}
                        onSetRole={channelRoles.setRole}
                        onRemoved={onMembersChanged}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : tab === "integrations" ? (
            <ChannelIntegrationsPanel channel={channel} />
          ) : (
            <ChannelSettingsPanel
              key={`${channel.id}|${channel.name}`}
              channel={channel}
              canManage={channelRoles.canManage}
              canArchive={channelRoles.canArchive}
            />
          )}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
        {/* Rendered inside the details popup so Base UI treats it as a nested dialog:
            interacting with or dismissing it never closes the details dialog underneath. */}
        <AddChannelMembersDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          channel={channel}
          currentMemberIds={memberIds}
          onAdded={onMembersChanged}
        />
        <ConfirmDialog
          open={confirmLeave}
          onOpenChange={setConfirmLeave}
          title={`Leave #${channel.name}?`}
          description={`You'll need an invite to rejoin #${channel.name}.`}
          confirmLabel="Leave"
          destructive
          onConfirm={leaveChannel}
        />
      </DialogContent>
    </Dialog>
  );
}
