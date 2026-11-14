"use client";

import { Check, Crown, ShieldCheck, X } from "lucide-react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { POLICY_META, ROLE_HINT, ROLE_LABEL, viewerCan, type WorkspaceSettings } from "@/lib/admin";
import { cn } from "@/lib/utils";

import { RoleBadge, Section, SkeletonBlock, WorkspaceIcon } from "./controls";

/** Read-only workspace overview for members and guests. */
export function AboutTab({ settings }: { settings: WorkspaceSettings | null }) {
  const ws = useWorkspace();
  const myRole = (ws.me && ws.memberById[ws.me.id]?.role) || "member";
  const people = ws.members.filter((m) => !m.is_bot);
  const owners = people.filter((m) => m.role === "owner");
  const admins = people.filter((m) => m.role === "admin");
  const name = settings?.name ?? ws.workspace?.name ?? "";

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-background p-4 shadow-xs sm:p-5">
        <WorkspaceIcon name={name} url={settings?.icon_url} size="xl" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-black">{name}</h2>
          <p className="truncate text-sm text-muted-foreground">worklio.app/{settings?.slug ?? ws.workspace?.slug}</p>
          {settings?.description && <p className="mt-2 text-sm whitespace-pre-wrap">{settings.description}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            {people.length} {people.length === 1 ? "member" : "members"}
            {ws.workspace?.created_at &&
              ` · created ${new Date(ws.workspace.created_at).toLocaleDateString([], { year: "numeric", month: "long" })}`}
          </p>
        </div>
      </div>

      <Section title="Your role" description={ROLE_HINT[myRole]}>
        <div className="flex items-center gap-2">
          <RoleBadge role={myRole} />
          <span className="text-sm text-muted-foreground">Ask an admin if you need different access.</span>
        </div>
      </Section>

      <Section title="Who manages this workspace">
        <ul className="grid gap-2 sm:grid-cols-2">
          {[...owners, ...admins].map((m) => (
            <li key={m.user_id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
              <UserAvatar id={m.user_id} name={m.full_name} online={ws.online.has(m.user_id)} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{m.full_name}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                {m.role === "owner" ? <Crown className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                {ROLE_LABEL[m.role]}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="What you can do" description="Set by your workspace admins.">
        {!settings ? (
          <SkeletonBlock rows={4} />
        ) : (
          <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {POLICY_META.map((p) => {
              const ok = viewerCan(settings, p.key, myRole);
              return (
                <li key={p.key} className="flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full",
                      ok ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {ok ? <Check className="size-3" /> : <X className="size-3" />}
                  </span>
                  <span className={ok ? "" : "text-muted-foreground"}>{p.label}</span>
                  <span className="sr-only">{ok ? "allowed" : "admins only"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
