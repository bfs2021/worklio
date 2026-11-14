"use client";

import { AtSign, Loader2, Pencil, Plus, Search, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";

import { refreshGroups, useGroupsLoaded, useUserGroups } from "@/components/messaging/use-groups";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, LoadingList } from "@/components/views/view-shell";
import { messaging, type UserGroup } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";

import { MemberPicker } from "./member-picker";
import { useWorkspace } from "./provider";

const RESERVED = new Set(["here", "channel", "everyone", "all", "admins"]);
const norm = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "");
/** "Design Team" → "design-team" (the backend accepts a-z, 0-9 and dashes). */
const toHandle = (s: string) =>
  norm(s)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/**
 * Directory → Groups: user groups (@design, @oncall) that can be @mentioned to reach every member.
 * Anyone (except guests) can create one; admins and the creator can edit or delete it.
 */
export function UserGroupsPanel({ query }: { query: string }) {
  const ws = useWorkspace();
  const groups = useUserGroups(ws.workspaceId);
  const loaded = useGroupsLoaded(ws.workspaceId);
  const [editing, setEditing] = useState<UserGroup | "new" | null>(null);
  const [deleting, setDeleting] = useState<UserGroup | null>(null);
  /** Optimistically hidden (being deleted) group ids. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const meId = ws.me?.id;
  const isGuest = ws.memberById[meId ?? ""]?.role === "guest";
  const canEdit = (g: UserGroup) => !isGuest && (ws.isAdmin || g.created_by === meId);

  const q = norm(query.trim());
  const list = groups
    .filter((g) => !hidden.has(g.id))
    .filter((g) => !q || norm(g.name).includes(q) || g.handle.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const remove = (g: UserGroup) => {
    setDeleting(null);
    setHidden((h) => new Set(h).add(g.id));
    messaging
      .deleteGroup(g.id)
      .then(() => {
        toast.success(`Deleted @${g.handle}`);
        refreshGroups(ws.workspaceId);
      })
      .catch((err) => {
        setHidden((h) => {
          const next = new Set(h);
          next.delete(g.id);
          return next;
        });
        toast.error(`Couldn't delete @${g.handle}: ${errorMessage(err)}`);
      });
  };

  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-3 sm:px-5">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
          Mention a group to notify everyone in it, e.g. <span className="font-semibold text-foreground">@design</span>.
        </p>
        {!isGuest && (
          <Button size="sm" onClick={() => setEditing("new")} className="shrink-0 bg-send text-white hover:bg-send/90">
            <Plus className="size-3.5" /> Create group
          </Button>
        )}
      </div>
      {!loaded ? (
        <LoadingList rows={4} />
      ) : !list.length ? (
        <EmptyState
          icon={q ? Search : UsersRound}
          title={q ? "No groups found" : "No user groups yet"}
          action={
            !q && !isGuest ? (
              <Button variant="outline" onClick={() => setEditing("new")}>
                <Plus className="size-4" /> Create a group
              </Button>
            ) : undefined
          }
        >
          {q
            ? `Nothing matches “${query.trim()}”.`
            : "Groups let you reach a whole team with one mention, like @engineering or @oncall."}
        </EmptyState>
      ) : (
        <ul role="list" className="mt-3 border-t">
          {list.map((g) => (
            <li key={g.id} className="group flex items-center gap-3 border-b px-4 py-3 hover:bg-muted/40 sm:px-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-mention text-link">
                <AtSign className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-bold">{g.name}</span>
                  <span className="shrink-0 text-[13px] text-muted-foreground">@{g.handle}</span>
                </p>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="flex -space-x-1.5">
                    {g.member_ids.slice(0, 5).map((id) => (
                      <UserAvatar
                        key={id}
                        id={id}
                        name={ws.memberById[id]?.full_name ?? "?"}
                        size="xs"
                        ringClassName="border-background"
                      />
                    ))}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {g.member_ids.length} {g.member_ids.length === 1 ? "member" : "members"}
                    {g.member_ids.includes(meId ?? "") && " · including you"}
                  </span>
                </div>
              </div>
              {canEdit(g) && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit @${g.handle}`} onClick={() => setEditing(g)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete @${g.handle}`}
                    onClick={() => setDeleting(g)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <GroupDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        group={editing}
        onClose={() => setEditing(null)}
      />
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete @{deleting?.handle}?</DialogTitle>
            <DialogDescription>
              Existing mentions stay in messages but will no longer notify anyone. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleting && remove(deleting)}>
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function GroupDialog({ group, onClose }: { group: UserGroup | "new" | null; onClose: () => void }) {
  const ws = useWorkspace();
  const existing = group && group !== "new" ? group : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [handle, setHandle] = useState(existing?.handle ?? "");
  const [handleTouched, setHandleTouched] = useState(!!existing);
  const [memberIds, setMemberIds] = useState<string[]>(existing?.member_ids ?? (ws.me ? [ws.me.id] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const effectiveHandle = handleTouched ? handle : toHandle(name);
  const handleError = !effectiveHandle
    ? ""
    : RESERVED.has(effectiveHandle)
      ? `@${effectiveHandle} is reserved`
      : !/^[a-z0-9][a-z0-9-]*$/.test(effectiveHandle)
        ? "Use lowercase letters, numbers and dashes"
        : "";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || handleError || !effectiveHandle || !name.trim()) return;
    setBusy(true);
    setError("");
    const data = { name: name.trim(), handle: effectiveHandle, member_ids: memberIds };
    const req = existing ? messaging.updateGroup(existing.id, data) : messaging.createGroup(ws.workspaceId, data);
    req
      .then((g) => {
        toast.success(existing ? `Updated @${g.handle}` : `Created @${g.handle}`);
        refreshGroups(ws.workspaceId);
        onClose();
      })
      .catch((err) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };

  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit @${existing.handle}` : "Create a user group"}</DialogTitle>
            <DialogDescription>Everyone in the group is notified when someone mentions its handle.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              placeholder="e.g. Design team"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-handle">Handle</Label>
            <div className="relative">
              <AtSign className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="group-handle"
                placeholder="design"
                value={effectiveHandle}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40));
                }}
                aria-invalid={!!handleError}
                aria-describedby="group-handle-hint"
                className="pl-7"
                required
              />
            </div>
            <p id="group-handle-hint" className={handleError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {handleError || "Lowercase letters, numbers and dashes."}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Members · {memberIds.length}</Label>
            <MemberPicker selected={memberIds} onChange={setMemberIds} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !!handleError || !effectiveHandle || !name.trim()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {existing ? "Save changes" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
