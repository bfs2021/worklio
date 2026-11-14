"use client";

import {
  Bot,
  Info,
  KeyRound,
  LayoutGrid,
  ScrollText,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AboutTab } from "@/components/admin/about-tab";
import { AITab } from "@/components/admin/ai-tab";
import { AppsTab } from "@/components/admin/apps-tab";
import { AuditTab } from "@/components/admin/audit-tab";
import { SkeletonBlock } from "@/components/admin/controls";
import { GeneralTab } from "@/components/admin/general-tab";
import { InvitationsTab } from "@/components/admin/invitations-tab";
import { MembersTab } from "@/components/admin/members-tab";
import { PermissionsTab } from "@/components/admin/permissions-tab";
import { ErrorBlock, ViewHeader, ViewPage, ViewTabs, type TabDef } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import { useWorkspaceSettings } from "@/lib/admin";

type AdminTab = "general" | "members" | "invitations" | "permissions" | "ai" | "apps" | "audit";

const ADMIN_TABS: readonly TabDef<AdminTab>[] = [
  { key: "general", label: "General", icon: Settings },
  { key: "members", label: "Members", icon: Users },
  { key: "invitations", label: "Invitations", icon: UserPlus },
  { key: "permissions", label: "Permissions", icon: ShieldCheck },
  { key: "ai", label: "AI", icon: KeyRound },
  { key: "apps", label: "Apps", icon: LayoutGrid },
  { key: "audit", label: "Audit log", icon: ScrollText },
];

const isAdminTab = (t: string | null): t is AdminTab => ADMIN_TABS.some((x) => x.key === t);

export function SettingsView() {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { settings, error, reload } = useWorkspaceSettings(ws.workspaceId);
  const raw = params.get("tab");
  const tab: AdminTab = isAdminTab(raw) ? raw : "general";

  const setTab = (t: AdminTab) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", t);
    router.replace(`${pathname}?${next}`, { scroll: false });
  };

  const membersReady = !!ws.me && ws.members.length > 0;
  const name = settings?.name ?? ws.workspace?.name ?? "Workspace";

  if (!membersReady) {
    return (
      <ViewPage label="Workspace settings">
        <ViewHeader icon={Settings} title="Workspace settings" />
        <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          <SkeletonBlock rows={5} />
        </div>
      </ViewPage>
    );
  }

  if (!ws.isAdmin) {
    return (
      <ViewPage label="About this workspace">
        <ViewHeader icon={Info} title={`About ${name}`} />
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            {error && !settings ? <ErrorBlock message={error} onRetry={() => reload().catch(() => {})} /> : <AboutTab settings={settings} />}
          </div>
        </div>
      </ViewPage>
    );
  }

  return (
    <ViewPage label="Workspace settings">
      <ViewHeader
        icon={Settings}
        title="Workspace settings"
        subtitle={name}
        actions={
          tab === "ai" ? (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <Bot className="size-3.5" /> Admins only
            </span>
          ) : null
        }
      >
        <ViewTabs tabs={ADMIN_TABS} value={tab} onChange={setTab} label="Settings sections" />
      </ViewHeader>
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30" id="settings-scroll">
        <div role="tabpanel" aria-label={ADMIN_TABS.find((t) => t.key === tab)?.label} className="mx-auto w-full max-w-4xl p-3 sm:p-6">
          {error && !settings && tab !== "audit" && tab !== "ai" ? (
            <ErrorBlock message={error} onRetry={() => reload().catch(() => {})} />
          ) : tab === "general" ? (
            settings ? <GeneralTab settings={settings} /> : <SkeletonBlock rows={4} />
          ) : tab === "members" ? (
            <MembersTab />
          ) : tab === "invitations" ? (
            <InvitationsTab />
          ) : tab === "permissions" ? (
            settings ? <PermissionsTab settings={settings} /> : <SkeletonBlock rows={8} />
          ) : tab === "ai" ? (
            <AITab />
          ) : tab === "apps" ? (
            <AppsTab onOpenAI={() => setTab("ai")} />
          ) : (
            <AuditTab />
          )}
        </div>
      </div>
    </ViewPage>
  );
}
