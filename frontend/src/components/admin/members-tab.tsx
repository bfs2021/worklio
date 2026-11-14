"use client";

import {
  ChevronDown,
  Crown,
  MoreHorizontal,
  Search,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBlock } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  fullDate,
  relativeTime,
  ROLE_HINT,
  ROLE_LABEL,
  type AdminMember,
  type MemberStatus,
  type WorkspaceRole,
} from "@/lib/admin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { NativeSelect, RoleBadge, Section, Segmented, SkeletonBlock } from "./controls";

type Pending =
  | { kind: "role"; member: AdminMember; role: WorkspaceRole }
  | { kind: "deactivate" | "reactivate" | "remove" | "transfer"; member: AdminMember }
  | null;

const ROLES: WorkspaceRole[] = ["owner", "admin", "member", "guest"];

export function MembersTab() {
  const ws = useWorkspace();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [role, setRole] = useState<WorkspaceRole | "">("");
  const [status, setStatus] = useState<MemberStatus>("active");
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<{ key: string; items: AdminMember[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const key = `${debouncedQ}\u0000${role}\u0000${status}\u0000${attempt}`;
  useEffect(() => {
    let live = true;
    adminApi
      .listMembers(ws.workspaceId, { q: debouncedQ, role, status })
      .then((items) => live && setData({ key, items }))
      .catch((err) => live && setFailure({ key, message: adminErrorMessage(err, "Couldn't load members") }));
    return () => {
      live = false;
    };
  }, [ws.workspaceId, debouncedQ, role, status, key]);

  const items = data?.key === key ? data.items : null;
  const error = failure?.key === key ? failure.message : "";
  const shown = items ?? (data && !error ? data.items : null); // keep old rows while a filter refetches

  const meId = ws.me?.id;
  const myRole = (meId && ws.memberById[meId]?.role) || "member";
  const isOwner = myRole === "owner";
  const ownerCount = ws.members.filter((m) => m.role === "owner").length;
  const primaryOwnerId = ws.workspace?.owner_id;
  const isPrimaryOwner = !!meId && meId === primaryOwnerId;

  const patchRow = (userId: string, fn: (m: AdminMember) => AdminMember | null) =>
    setData((d) =>
      d
        ? {
            ...d,
            items: d.items.flatMap((m) => {
              if (m.user_id !== userId) return [m];
              const next = fn(m);
              return next ? [next] : [];
            }),
          }
        : d,
    );

  const roleBlock = (m: AdminMember): string | null => {
    if (m.is_bot) return "Apps don't have a workspace role";
    if (m.user_id === meId) return "You can't change your own role";
    if (m.status === "deactivated") return "Reactivate this person to change their role";
    if ((m.role === "owner" || m.role === "admin") && !isOwner) return "Only workspace owners can change admins and owners";
    if (m.role === "owner" && ownerCount <= 1) return "A workspace needs at least one owner";
    if (m.user_id === primaryOwnerId) return "The primary owner's role changes only through an ownership transfer";
    return null;
  };
  const canManage = (m: AdminMember) =>
    !m.is_bot &&
    m.user_id !== meId &&
    m.user_id !== primaryOwnerId &&
    (isOwner ? m.role !== "owner" || ownerCount > 1 : m.role === "member" || m.role === "guest");

  const changeRole = async (m: AdminMember, next: WorkspaceRole) => {
    if (next === m.role) return;
    patchRow(m.user_id, (x) => ({ ...x, role: next }));
    try {
      await adminApi.setRole(ws.workspaceId, m.user_id, next);
      toast.success(`${m.full_name} is now ${next === "admin" || next === "owner" ? "an" : "a"} ${ROLE_LABEL[next].toLowerCase()}`);
      ws.reloadMembers().catch(() => {});
    } catch (err) {
      patchRow(m.user_id, (x) => ({ ...x, role: m.role }));
      throw new Error(adminErrorMessage(err, "Couldn't change the role"));
    }
  };

  const requestRole = (m: AdminMember, next: WorkspaceRole) => {
    // Guests lose access to most channels and owners get full control: confirm both.
    if (next === "guest" || next === "owner") return setPending({ kind: "role", member: m, role: next });
    changeRole(m, next).catch((err) => toast.error(adminErrorMessage(err)));
  };

  const setActive = async (m: AdminMember, active: boolean) => {
    patchRow(m.user_id, (x) => (status === (active ? "active" : "deactivated") ? { ...x, status: active ? "active" : "deactivated" } : null));
    try {
      await (active ? adminApi.reactivate : adminApi.deactivate)(ws.workspaceId, m.user_id);
      toast.success(active ? `${m.full_name} was reactivated` : `${m.full_name} was deactivated`);
      ws.reloadMembers().catch(() => {});
    } catch (err) {
      setAttempt((n) => n + 1);
      throw new Error(adminErrorMessage(err, active ? "Couldn't reactivate" : "Couldn't deactivate"));
    }
  };

  const remove = async (m: AdminMember) => {
    patchRow(m.user_id, () => null);
    try {
      await adminApi.removeMember(ws.workspaceId, m.user_id);
      toast.success(`${m.full_name} was removed from ${ws.workspace?.name ?? "the workspace"}`);
      ws.reloadMembers().catch(() => {});
    } catch (err) {
      setAttempt((n) => n + 1);
      throw new Error(adminErrorMessage(err, "Couldn't remove this person"));
    }
  };

  const transfer = async (m: AdminMember) => {
    try {
      await adminApi.transferOwnership(ws.workspaceId, m.user_id);
      toast.success(`${m.full_name} now owns ${ws.workspace?.name ?? "the workspace"}`);
      setAttempt((n) => n + 1);
      await Promise.all([ws.reloadMembers(), ws.reloadWorkspaces()]);
    } catch (err) {
      throw new Error(adminErrorMessage(err, "Couldn't transfer ownership"));
    }
  };

  return (
    <Section
      title="Members"
      description="Manage roles and access. Deactivated people can't sign in to this workspace, but their messages stay."
      actions={
        <Button render={<Link href="?tab=invitations" />} nativeButton={false} className="bg-send text-white hover:bg-send/90">
          <UserPlus /> Invite people
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email"
            aria-label="Search members"
            className="pl-8"
          />
        </div>
        <NativeSelect
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setRole(e.target.value as WorkspaceRole | "")}
          className="w-auto"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}s
            </option>
          ))}
        </NativeSelect>
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "active", label: "Active" },
            { value: "deactivated", label: "Deactivated" },
          ]}
        />
      </div>

      <div className="mt-4">
        {error ? (
          <ErrorBlock message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !shown ? (
          <SkeletonBlock rows={6} />
        ) : shown.length === 0 ? (
          <EmptyState icon={Users} title={debouncedQ || role ? "No one matches" : status === "deactivated" ? "No deactivated members" : "No members yet"}>
            {debouncedQ || role ? "Try a different search or role." : status === "deactivated" ? "People you deactivate show up here." : "Invite your team to get started."}
          </EmptyState>
        ) : (
          <div className={cn("-mx-4 overflow-x-auto sm:-mx-5", !items && "opacity-60 transition-opacity")}>
            <table className="w-full min-w-0 text-sm">
              <caption className="sr-only">Workspace members</caption>
              <thead className="border-y bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-2 pl-4 font-semibold sm:pl-5">Name</th>
                  <th scope="col" className="w-px px-2 py-2 font-semibold whitespace-nowrap">Role</th>
                  <th scope="col" className="hidden w-px px-2 py-2 font-semibold whitespace-nowrap md:table-cell">Status</th>
                  <th scope="col" className="hidden w-px px-2 py-2 font-semibold whitespace-nowrap lg:table-cell">Joined</th>
                  <th scope="col" className="hidden w-px px-4 py-2 font-semibold whitespace-nowrap lg:table-cell">Last active</th>
                  <th scope="col" className="w-10 py-2 pr-4 pl-2 sm:pr-5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((m) => {
                  const block = roleBlock(m);
                  const manageable = canManage(m);
                  const canTransfer = isPrimaryOwner && m.user_id !== meId && !m.is_bot && m.status === "active" && m.role !== "guest";
                  return (
                    <tr key={m.user_id} className={cn("align-middle", m.status === "deactivated" && "text-muted-foreground")}>
                      <td className="max-w-0 py-2.5 pr-2 pl-4 sm:pl-5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <UserAvatar id={m.user_id} name={m.full_name} online={ws.online.has(m.user_id)} className={m.status === "deactivated" ? "opacity-50 grayscale" : undefined} />
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-bold text-foreground">{m.full_name}</span>
                              {m.user_id === meId && <span className="shrink-0 text-xs text-muted-foreground">(you)</span>}
                              {m.is_bot && <RoleBadge role="bot" />}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                            <div className="mt-0.5 md:hidden">
                              {m.status === "deactivated" && <RoleBadge role="deactivated" />}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap">
                        {m.is_bot ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : block ? (
                          <span title={block}>
                            <RoleBadge role={m.role} />
                          </span>
                        ) : (
                          <RoleMenu member={m} isOwner={isOwner} onPick={(r) => requestRole(m, r)} />
                        )}
                      </td>
                      <td className="hidden px-2 py-2.5 whitespace-nowrap md:table-cell">
                        {m.status === "deactivated" ? (
                          <RoleBadge role="deactivated" />
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> Active
                          </span>
                        )}
                      </td>
                      <td className="hidden px-2 py-2.5 text-xs whitespace-nowrap text-muted-foreground lg:table-cell" title={fullDate(m.joined_at)}>
                        {new Date(m.joined_at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}
                      </td>
                      <td className="hidden px-4 py-2.5 text-xs whitespace-nowrap text-muted-foreground lg:table-cell" title={fullDate(m.last_active_at)}>
                        {ws.online.has(m.user_id) ? "Online now" : relativeTime(m.last_active_at)}
                      </td>
                      <td className="py-2.5 pr-4 pl-2 text-right sm:pr-5">
                        {(manageable || canTransfer) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`Actions for ${m.full_name}`}
                              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-popup-open:bg-muted"
                            >
                              <MoreHorizontal className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              {manageable &&
                                (m.status === "active" ? (
                                  <DropdownMenuItem onClick={() => setPending({ kind: "deactivate", member: m })}>
                                    <UserX className="size-4" /> Deactivate account
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => setPending({ kind: "reactivate", member: m })}>
                                    <UserCheck className="size-4" /> Reactivate account
                                  </DropdownMenuItem>
                                ))}
                              {canTransfer && (
                                <DropdownMenuItem onClick={() => setPending({ kind: "transfer", member: m })}>
                                  <Crown className="size-4" /> Transfer ownership…
                                </DropdownMenuItem>
                              )}
                              {manageable && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem variant="destructive" onClick={() => setPending({ kind: "remove", member: m })}>
                                    <UserMinus className="size-4" /> Remove from workspace
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PendingDialog pending={pending} onClose={() => setPending(null)} workspaceName={ws.workspace?.name ?? "this workspace"} run={{ changeRole, setActive, remove, transfer }} />
    </Section>
  );
}

function RoleMenu({ member, isOwner, onPick }: { member: AdminMember; isOwner: boolean; onPick: (r: WorkspaceRole) => void }) {
  const options = ROLES.filter((r) => isOwner || (r !== "owner" && r !== "admin"));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Role for ${member.full_name}: ${ROLE_LABEL[member.role]}`}
        className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-xs font-semibold outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 data-popup-open:bg-muted"
      >
        {ROLE_LABEL[member.role]}
        <ChevronDown className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace role</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={member.role} onValueChange={(v) => onPick(v as WorkspaceRole)}>
            {options.map((r) => (
              <DropdownMenuRadioItem key={r} value={r} className="items-start py-1.5">
                <span className="flex flex-col">
                  <span className="font-semibold">{ROLE_LABEL[r]}</span>
                  <span className="text-xs text-muted-foreground">{ROLE_HINT[r]}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {!isOwner && <p className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">Only owners can make someone an admin or owner.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PendingDialog({
  pending,
  onClose,
  workspaceName,
  run,
}: {
  pending: Pending;
  onClose: () => void;
  workspaceName: string;
  run: {
    changeRole: (m: AdminMember, r: WorkspaceRole) => Promise<void>;
    setActive: (m: AdminMember, active: boolean) => Promise<void>;
    remove: (m: AdminMember) => Promise<void>;
    transfer: (m: AdminMember) => Promise<void>;
  };
}) {
  const open = pending !== null;
  const m = pending?.member;
  const name = m?.full_name ?? "";
  const copy: Record<string, { title: string; description: string; label: string; destructive?: boolean }> = {
    role:
      pending?.kind === "role" && pending.role === "owner"
        ? {
            title: `Make ${name} an owner?`,
            description: `Owners have full control of ${workspaceName}, including other admins and owners.`,
            label: "Make owner",
          }
        : {
            title: `Make ${name} a guest?`,
            description: "Guests only see channels they're explicitly added to and can't create channels or invite people.",
            label: "Make guest",
            destructive: true,
          },
    deactivate: {
      title: `Deactivate ${name}?`,
      description: `${name} will be signed out of ${workspaceName} right away and can't access it until reactivated. Their messages and files stay.`,
      label: "Deactivate",
      destructive: true,
    },
    reactivate: {
      title: `Reactivate ${name}?`,
      description: `${name} will get access to ${workspaceName} again with their previous role and channels.`,
      label: "Reactivate",
    },
    remove: {
      title: `Remove ${name} from ${workspaceName}?`,
      description: "They'll lose access immediately and be removed from every channel. You can invite them again later.",
      label: "Remove",
      destructive: true,
    },
    transfer: {
      title: `Transfer ownership to ${name}?`,
      description: `${name} becomes the primary owner of ${workspaceName}. You'll stay on as an admin and can't undo this yourself.`,
      label: "Transfer ownership",
      destructive: true,
    },
  };
  const c = pending ? copy[pending.kind] : copy.remove;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={c.title}
      description={c.description}
      confirmLabel={c.label}
      destructive={c.destructive}
      onConfirm={async () => {
        if (!pending) return;
        const mem = pending.member;
        if (pending.kind === "role") await run.changeRole(mem, pending.role);
        else if (pending.kind === "deactivate") await run.setActive(mem, false);
        else if (pending.kind === "reactivate") await run.setActive(mem, true);
        else if (pending.kind === "remove") await run.remove(mem);
        else await run.transfer(mem);
      }}
    />
  );
}
