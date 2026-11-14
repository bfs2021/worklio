"use client";

import {
  Archive,
  Hash,
  LayoutGrid,
  Lock,
  Phone,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useWorkspace } from "@/components/workspace/provider";
import {
  adminApi,
  adminErrorMessage,
  notifyAIChanged,
  POLICY_META,
  settingsStore,
  type PolicyKey,
  type PolicyValue,
  type WorkspaceSettings,
} from "@/lib/admin";
import { toast } from "@/lib/toast";

import { Section, Segmented } from "./controls";

const ICONS: Record<PolicyKey, LucideIcon> = {
  create_public_channels: Hash,
  create_private_channels: Lock,
  invite_members: UserPlus,
  create_user_groups: Users,
  start_huddles: Phone,
  use_ai: Sparkles,
  install_apps: LayoutGrid,
  archive_channels: Archive,
};

const OPTIONS = [
  { value: "everyone" as const, label: "Everyone" },
  { value: "admins" as const, label: "Admins only" },
];

export function PermissionsTab({ settings }: { settings: WorkspaceSettings }) {
  const ws = useWorkspace();

  const set = async (key: PolicyKey, value: PolicyValue) => {
    const prev = settings.policies[key];
    settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, policies: { ...s.policies, [key]: value } } : s));
    try {
      await adminApi.patchSettings(ws.workspaceId, { policies: { [key]: value } });
      if (key === "use_ai" || key === "install_apps") notifyAIChanged(ws.workspaceId);
      toast.success("Permission updated");
    } catch (err) {
      settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, policies: { ...s.policies, [key]: prev } } : s));
      toast.error(adminErrorMessage(err, "Couldn't update the permission"));
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Permissions"
        description="Choose who can do what. Owners and admins can always do everything; guests can never do these."
      >
        <ul className="-mx-4 -my-4 divide-y sm:-mx-5">
          {POLICY_META.map((p) => {
            const Icon = ICONS[p.key];
            const value = settings.policies?.[p.key] ?? "everyone";
            return (
              <li key={p.key} className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm font-bold" id={`policy-${p.key}`}>
                    {p.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                </div>
                <Segmented label={p.label} value={value} onChange={(v) => set(p.key, v)} options={OPTIONS} size="sm" />
              </li>
            );
          })}
        </ul>
      </Section>
      <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" aria-hidden /> Changes apply immediately and are recorded in the audit log.
      </p>
    </div>
  );
}
