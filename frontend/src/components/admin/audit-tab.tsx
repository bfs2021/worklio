"use client";

import { ScrollText } from "lucide-react";
import { Fragment, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { usePaged } from "@/components/views/use-paged";
import { EmptyState, ErrorBlock, LoadMore } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import { adminApi, fullDate, humanizeAction, type AuditEvent } from "@/lib/admin";

import { NativeSelect, Section, SkeletonBlock } from "./controls";

/** Prefix filters (the API matches "member." etc. by prefix). */
const CATEGORIES = [
  { value: "member.", label: "Members & roles" },
  { value: "workspace.", label: "Workspace & permissions" },
  { value: "invite_link.", label: "Invite links" },
  { value: "channel.", label: "Channels" },
  { value: "ai.", label: "AI settings" },
  { value: "app.", label: "Apps" },
];

const KNOWN_ACTIONS = [
  "member.role_changed",
  "member.deactivated",
  "member.reactivated",
  "member.removed",
  "member.added",
  "member.joined_via_invite",
  "workspace.ownership_transferred",
  "workspace.settings_updated",
  "workspace.policy_changed",
  "workspace.icon_updated",
  "workspace.icon_removed",
  "invite_link.created",
  "invite_link.revoked",
  "ai.settings_updated",
  "app.installed",
  "app.uninstalled",
  "channel.archived",
  "channel.unarchived",
  "channel.renamed",
  "channel.member_role_changed",
  "channel.member_removed",
];

const SECRET_KEY = /(key|token|secret|password)/i;

function describeTarget(e: AuditEvent, ws: ReturnType<typeof useWorkspace>): string | null {
  const meta = e.meta ?? {};
  const metaName = typeof meta.name === "string" ? meta.name : typeof meta.target_name === "string" ? meta.target_name : null;
  const metaUser = typeof meta.user_id === "string" ? ws.memberById[meta.user_id]?.full_name : undefined;
  if (e.target_type === "channel" && metaUser) {
    const ch = e.target_id ? ws.channels.find((c) => c.id === e.target_id) : undefined;
    return `${metaUser} in #${ch?.name ?? metaName ?? "channel"}`;
  }
  switch (e.target_type) {
    case "user":
    case "member":
      return e.target_name || (e.target_id && ws.memberById[e.target_id]?.full_name) || metaName || "a member";
    case "channel": {
      const ch = e.target_id ? ws.channels.find((c) => c.id === e.target_id) : undefined;
      return `#${ch?.name ?? metaName ?? "channel"}`;
    }
    case "invite_link":
      return "an invite link";
    case "workspace":
      return ws.workspace?.name ?? "the workspace";
    case null:
    case undefined:
      return metaName;
    default:
      return metaName ?? e.target_type.replace(/_/g, " ");
  }
}

function metaChips(meta: AuditEvent["meta"]): string[] {
  if (!meta) return [];
  const out: string[] = [];
  if (meta.from !== undefined && meta.to !== undefined) out.push(`${String(meta.from ?? "none")} → ${String(meta.to ?? "none")}`);
  for (const [k, v] of Object.entries(meta)) {
    if (["from", "to", "name", "target_name"].includes(k) || SECRET_KEY.test(k) || k.endsWith("_id") || k.endsWith("_ids")) continue;
    if (v === null || v === undefined || typeof v === "object") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const keys = Object.keys(v).filter((x) => !SECRET_KEY.test(x));
        if (keys.length) out.push(`${k.replace(/_/g, " ")}: ${keys.map((x) => x.replace(/_/g, " ")).join(", ")}`);
      }
      continue;
    }
    out.push(`${k.replace(/_/g, " ")}: ${String(v)}`);
  }
  return out.slice(0, 4);
}

export function AuditTab() {
  const ws = useWorkspace();
  const [action, setAction] = useState("");
  const paged = usePaged<AuditEvent>(
    `${ws.workspaceId}|${action}`,
    (cursor) => adminApi.auditLog(ws.workspaceId, cursor, action),
    (e) => e.id,
  );
  const items = paged.items;
  const options = Array.from(
    new Set([...KNOWN_ACTIONS, ...(items ?? []).map((e) => e.action), ...(action && !action.endsWith(".") ? [action] : [])]),
  ).sort();

  const dayOf = (iso: string) =>
    new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return (
    <Section
      title="Audit log"
      description="A record of sensitive changes: roles, access, settings, invites, AI and apps. API keys are never logged."
      actions={
        <NativeSelect aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)} className="w-auto max-w-56">
          <option value="">All activity</option>
          <optgroup label="Categories">
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Specific actions">
            {options.map((a) => (
              <option key={a} value={a}>
                {humanizeAction(a)}
              </option>
            ))}
          </optgroup>
        </NativeSelect>
      }
    >
      {paged.error ? (
        <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />
      ) : !items ? (
        <SkeletonBlock rows={6} />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title={action ? "Nothing matches this filter" : "No events yet"}>
          {action ? "Try another action." : "Admin changes will show up here."}
        </EmptyState>
      ) : (
        <>
          <ol className="-mx-4 -my-4 sm:-mx-5">
            {items.map((e, i) => {
              const day = dayOf(e.created_at);
              const header = i === 0 || dayOf(items[i - 1].created_at) !== day;
              const actor = e.actor_id ? (ws.memberById[e.actor_id]?.full_name ?? e.actor_name ?? "Former member") : (e.actor_name ?? "Worklio");
              const target = describeTarget(e, ws);
              const chips = metaChips(e.meta);
              return (
                <Fragment key={e.id}>
                  {header && (
                    <li className="sticky top-0 z-[1] border-y bg-muted/60 px-4 py-1.5 text-xs font-bold text-muted-foreground backdrop-blur first:border-t-0 sm:px-5">
                      {day}
                    </li>
                  )}
                  <li className="flex gap-3 px-4 py-3 sm:px-5">
                    {e.actor_id ? (
                      <UserAvatar id={e.actor_id} name={actor} />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <ScrollText className="size-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-bold">{actor}</span>{" "}
                        <span className="text-muted-foreground">·</span> <span className="font-semibold">{humanizeAction(e.action)}</span>
                        {target && (
                          <>
                            {" "}
                            <span className="text-muted-foreground">·</span> <span>{target}</span>
                          </>
                        )}
                      </p>
                      {chips.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {chips.map((c) => (
                            <span key={c} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <time dateTime={e.created_at} title={fullDate(e.created_at)} className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                      {new Date(e.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </time>
                  </li>
                </Fragment>
              );
            })}
          </ol>
          <div className="mt-4">
            <LoadMore hasMore={paged.hasMore} loading={paged.loadingMore} error={paged.moreError} onMore={paged.loadMore} />
          </div>
        </>
      )}
    </Section>
  );
}
