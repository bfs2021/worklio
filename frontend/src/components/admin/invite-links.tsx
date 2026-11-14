"use client";

import { Check, Copy, Hash, Link2, Lock, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  fullDate,
  inviteState,
  inviteUrl,
  relativeTime,
  type InviteLink,
} from "@/lib/admin";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { NativeSelect, RoleBadge, Segmented, Spinner } from "./controls";

const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "never", label: "Never" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

const MAX_USES = ["", "1", "5", "10", "25", "50", "100"] as const;

/** Copy an invite link with feedback. */
export async function copyInvite(token: string) {
  try {
    await copyText(inviteUrl(token));
    toast.success("Invite link copied");
  } catch (err) {
    toast.error(adminErrorMessage(err, "Couldn't copy the link"));
  }
}

/**
 * Create-link form. `allowGuests` is false for non-admin quick invites (guest links are admin-only).
 */
export function InviteLinkForm({
  onCreated,
  allowGuests = true,
  compact,
}: {
  onCreated: (link: InviteLink) => void;
  allowGuests?: boolean;
  compact?: boolean;
}) {
  const ws = useWorkspace();
  const [role, setRole] = useState<"member" | "guest">("member");
  const [expiry, setExpiry] = useState<Expiry>("7");
  const [maxUses, setMaxUses] = useState<(typeof MAX_USES)[number]>("");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const channels = ws.channels
    .filter((c) => c.kind !== "dm" && !c.is_archived && (c.kind === "public" || c.is_member))
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = channels.filter((c) => c.name.includes(filter.trim().toLowerCase()));
  const guestMissing = role === "guest" && channelIds.length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || guestMissing) return;
    setBusy(true);
    setError("");
    try {
      const link = await adminApi.createInviteLink(ws.workspaceId, {
        role,
        channel_ids: role === "guest" ? channelIds : [],
        expires_in_hours: expiry === "never" ? null : Number(expiry) * 24,
        max_uses: maxUses ? Number(maxUses) : null,
      });
      onCreated(link);
      await copyInvite(link.token);
      setChannelIds([]);
    } catch (err) {
      setError(adminErrorMessage(err, "Couldn't create the link"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className={cn("grid gap-3", compact ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
        {allowGuests && (
          <div className="space-y-1.5">
            <span className="block text-xs font-bold text-muted-foreground">
              Join as
            </span>
            <Segmented
              label="Join as"
              value={role}
              onChange={setRole}
              options={[
                { value: "member", label: "Member" },
                { value: "guest", label: "Guest" },
              ]}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <label htmlFor="invite-expiry" className="block text-xs font-bold text-muted-foreground">
            Expires after
          </label>
          <NativeSelect id="invite-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
            {EXPIRY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="invite-uses" className="block text-xs font-bold text-muted-foreground">
            Max uses
          </label>
          <NativeSelect id="invite-uses" value={maxUses} onChange={(e) => setMaxUses(e.target.value as (typeof MAX_USES)[number])}>
            {MAX_USES.map((v) => (
              <option key={v} value={v}>
                {v ? `${v} ${v === "1" ? "person" : "people"}` : "No limit"}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {role === "guest" && (
        <fieldset className="rounded-lg border">
          <legend className="ml-2 px-1 text-xs font-bold text-muted-foreground">
            Guest channels <span className="font-normal">({channelIds.length} selected)</span>
          </legend>
          <div className="relative border-b p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a channel" aria-label="Find a channel" className="h-7 pl-7 text-[13px]" />
          </div>
          <ul className="max-h-48 overflow-y-auto p-1">
            {visible.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted-foreground">No channels match.</li>}
            {visible.map((c) => {
              const checked = channelIds.includes(c.id);
              const Icon = c.kind === "private" ? Lock : Hash;
              return (
                <li key={c.id}>
                  <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-send)]"
                      checked={checked}
                      onChange={() => setChannelIds((ids) => (checked ? ids.filter((x) => x !== c.id) : [...ids, c.id]))}
                    />
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {guestMissing && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Guests only see the channels you pick here.</p>}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || guestMissing} className="bg-send text-white hover:bg-send/90">
          {busy ? <Spinner /> : <Link2 />}
          Create &amp; copy link
        </Button>
      </div>
    </form>
  );
}

/** One invite link row: URL + copy, role, uses, expiry, creator, revoke. */
export function InviteLinkRow({ link, onRevoke }: { link: InviteLink; onRevoke?: (link: InviteLink) => void }) {
  const ws = useWorkspace();
  const [copied, setCopied] = useState(false);
  const state = inviteState(link);
  const active = state === "active";
  const creator = (link.created_by && ws.memberById[link.created_by]?.full_name) || "a former member";
  const channelNames = link.channel_ids
    .map((id) => ws.channels.find((c) => c.id === id)?.name)
    .filter(Boolean) as string[];

  const copy = async () => {
    await copyInvite(link.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const stateLabel: Record<typeof state, string> = {
    active: link.expires_at ? `Expires ${relativeTime(link.expires_at)}` : "Never expires",
    expired: "Expired",
    used_up: "Used up",
    revoked: "Revoked",
  };

  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5", !active && "opacity-60")}>
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <code className="min-w-0 truncate font-mono text-[13px]" title={inviteUrl(link.token)}>
            {inviteUrl(link.token).replace(/^https?:\/\//, "")}
          </code>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
          <RoleBadge role={link.role} />
          <span className="tabular-nums">
            {link.uses} {link.max_uses != null ? `/ ${link.max_uses} ` : ""}
            {link.uses === 1 && link.max_uses == null ? "use" : "uses"}
          </span>
          <span aria-hidden>·</span>
          <span title={fullDate(link.expires_at)} className={cn(!active && "font-semibold text-destructive")}>
            {stateLabel[state]}
          </span>
          <span aria-hidden>·</span>
          <span>by {creator}</span>
          {link.role === "guest" && channelNames.length > 0 && (
            <span className="min-w-0 truncate">
              <span aria-hidden>· </span>
              {channelNames.map((n) => `#${n}`).join(", ")}
            </span>
          )}
        </div>
      </div>
      {active && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={copy} aria-label="Copy invite link">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy"}
          </Button>
          {onRevoke && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onRevoke(link)}>
              <Trash2 /> Revoke
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
