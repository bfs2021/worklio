/**
 * Workspace administration client (Wave D1): settings + policies, member admin, invite links,
 * channel managers, audit log, per-workspace AI provider settings and Worklio AI app installs.
 *
 * Two small shared stores (workspace settings, workspace AI status) are exposed as hooks so the
 * sidebar, the channel details dialog and the settings page all read the same cached data.
 */
import { useEffect, useSyncExternalStore } from "react";

import { AI_SETTINGS_CHANGED_EVENT } from "@/lib/ai";
import { ApiError, api } from "@/lib/api";

// --- Policies ------------------------------------------------------------------------------

export type PolicyKey =
  | "create_public_channels"
  | "create_private_channels"
  | "invite_members"
  | "create_user_groups"
  | "start_huddles"
  | "use_ai"
  | "install_apps"
  | "archive_channels";

export type PolicyValue = "everyone" | "admins";
export type Policies = Record<PolicyKey, PolicyValue>;

export const POLICY_META: { key: PolicyKey; label: string; description: string }[] = [
  {
    key: "create_public_channels",
    label: "Create public channels",
    description: "Start new channels that anyone in the workspace can find and join.",
  },
  {
    key: "create_private_channels",
    label: "Create private channels",
    description: "Start invite-only channels that are hidden from people who aren't in them.",
  },
  {
    key: "invite_members",
    label: "Invite people",
    description: "Create invite links and add new people to the workspace.",
  },
  {
    key: "create_user_groups",
    label: "Create user groups",
    description: "Create @handles like @design that notify a whole team at once.",
  },
  {
    key: "start_huddles",
    label: "Start huddles and calls",
    description: "Start audio and video huddles in channels and DMs.",
  },
  {
    key: "use_ai",
    label: "Use Worklio AI",
    description: "Ask Worklio, summaries, writing help, translation and the @worklio agent.",
  },
  {
    key: "install_apps",
    label: "Add apps to channels",
    description: "Add Worklio AI and other apps to channels they're a member of.",
  },
  {
    key: "archive_channels",
    label: "Archive channels",
    description: "Channel managers can archive channels they manage. Admins always can.",
  },
];

export const POLICY_LABEL = Object.fromEntries(POLICY_META.map((p) => [p.key, p.label])) as Record<PolicyKey, string>;

/** Whether someone with `role` may do `policy` (admins always, guests never; unknown policies deny members). */
export function policyAllows(policies: Policies | null | undefined, policy: PolicyKey, role: string | undefined): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role !== "member" || !policies) return false;
  return policies[policy] === "everyone";
}

/** The viewer's own permission, preferring the server-computed `viewer_can` from GET /settings. */
export function viewerCan(settings: WorkspaceSettings | null | undefined, policy: PolicyKey, role: string | undefined): boolean {
  const server = settings?.viewer_can?.[policy];
  if (typeof server === "boolean") return server;
  return policyAllows(settings?.policies, policy, role);
}

/** Readable text for an error, translating `policy:<name>` / `ai_feature_disabled` details. */
export function adminErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (msg.startsWith("policy:")) {
    const key = msg.slice("policy:".length) as PolicyKey;
    const label = POLICY_LABEL[key];
    return label
      ? `Only workspace admins can ${label.charAt(0).toLowerCase()}${label.slice(1)} here.`
      : "An admin has restricted this action.";
  }
  if (msg === "ai_feature_disabled") return "An admin has turned this Worklio AI feature off.";
  if (err instanceof ApiError && err.status === 403 && !msg) return "You don't have permission to do that.";
  return msg || fallback;
}

// --- Workspace settings --------------------------------------------------------------------

export type WorkspaceSettings = {
  id?: string;
  owner_id?: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  policies: Policies;
  default_channel_ids: string[];
  /** The viewer's workspace role and what they may do under the current policies. */
  viewer_role?: WorkspaceRole;
  viewer_can?: Partial<Record<PolicyKey, boolean>>;
};

export type WorkspaceSettingsPatch = Partial<{
  name: string;
  slug: string;
  description: string | null;
  policies: Partial<Policies>;
  default_channel_ids: string[];
}>;

// --- Members -------------------------------------------------------------------------------

export type WorkspaceRole = "owner" | "admin" | "member" | "guest";
export type MemberStatus = "active" | "deactivated";

export type AdminMember = {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url?: string | null;
  role: WorkspaceRole;
  status: MemberStatus;
  joined_at: string;
  deactivated_at?: string | null;
  last_active_at: string | null;
  is_bot: boolean;
};

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

export const ROLE_HINT: Record<WorkspaceRole, string> = {
  owner: "Full control, including billing-level settings and ownership.",
  admin: "Manages members, channels, permissions and apps.",
  member: "Full access to public channels and everyday features.",
  guest: "Only sees the channels they were invited to.",
};

// --- Invite links --------------------------------------------------------------------------

export type InviteLink = {
  id: string;
  token: string;
  role: "member" | "guest";
  channel_ids: string[];
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  created_by: string | null;
  created_at?: string;
  revoked: boolean;
  /** Server-derived: false once revoked, expired or used up. */
  valid?: boolean;
};

export type InviteLinkCreate = {
  role: "member" | "guest";
  channel_ids: string[];
  /** Hours until the link stops working (1–2160); null = never expires. */
  expires_in_hours: number | null;
  max_uses: number | null;
};

export type InvitePreview = {
  workspace_name: string;
  workspace_icon_url: string | null;
  inviter_name: string | null;
  role: "member" | "guest";
  valid: boolean;
  reason?: "revoked" | "expired" | "used_up" | null;
};

export function inviteUrl(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/invite/${token}`;
}

export type InviteState = "active" | "expired" | "used_up" | "revoked";

export function inviteState(link: InviteLink, now = Date.now()): InviteState {
  if (link.revoked) return "revoked";
  if (link.max_uses != null && link.uses >= link.max_uses) return "used_up";
  if (link.expires_at && new Date(link.expires_at).getTime() <= now) return "expired";
  if (link.max_uses != null && link.uses >= link.max_uses) return "used_up";
  return "active";
}

// --- Channel managers ----------------------------------------------------------------------

export type ChannelRole = "member" | "manager";
export type ChannelRoles = {
  manager_ids: string[];
  /** The viewer may rename the channel and remove or promote people. */
  can_manage: boolean;
  /** The viewer may archive/unarchive (manager/admin + archive_channels policy; never #general). */
  can_archive: boolean;
};

// --- Audit log -----------------------------------------------------------------------------

export type AuditEvent = {
  id: string;
  workspace_id: string;
  actor_id: string | null;
  actor_name?: string | null;
  target_name?: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type AuditPage = { items: AuditEvent[]; next_cursor: string | null };

/** "member.role_changed" → "Member role changed". */
export function humanizeAction(action: string): string {
  const s = action.replace(/[._:-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : action;
}

// --- AI settings ---------------------------------------------------------------------------

export type AIProvider = "anthropic" | "gemini" | "deepseek";
export type AIFeatureKey = "ask" | "summaries" | "composer" | "translate" | "tasks" | "agent" | "captions_summary";
export type AIFeatures = Record<AIFeatureKey, boolean>;

export const AI_FEATURE_META: { key: AIFeatureKey; label: string; description: string }[] = [
  { key: "ask", label: "Ask Worklio", description: "Answers questions from conversations each person can access." },
  { key: "summaries", label: "Summaries", description: "Channel and thread recaps, catch-up digests." },
  { key: "composer", label: "Writing help", description: "Rewrite, shorten, fix and change tone in the composer." },
  { key: "translate", label: "Translate", description: "Translate messages into each person's language." },
  { key: "tasks", label: "Task extraction", description: "Turn conversations into to-dos with owners and due dates." },
  { key: "agent", label: "@worklio agent", description: "Mention @worklio in channels where the app is added." },
  { key: "captions_summary", label: "Call summaries", description: "Notes and action items from huddle captions." },
];

export const AI_PROVIDERS: {
  id: AIProvider;
  name: string;
  vendor: string;
  description: string;
  keyPlaceholder: string;
  keyUrl: string;
  defaultModel: string | null;
}[] = [
  {
    id: "anthropic",
    name: "Claude",
    vendor: "Anthropic",
    description: "Careful reasoning, long context and reliable tool use. Recommended for the @worklio agent.",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-opus-5-5",
  },
  {
    id: "gemini",
    name: "Gemini",
    vendor: "Google",
    description: "Fast multimodal models from Google. Test your key to pick from the models it can use.",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: null,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    vendor: "DeepSeek",
    description: "Cost-efficient chat and reasoning models with function calling.",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
  },
];

export type WorkspaceAISettings = {
  provider: AIProvider | null;
  model: string | null;
  key_set: boolean;
  key_hint: string | null;
  source: "workspace" | "env" | null;
  features: AIFeatures;
  per_user_limit: number;
  updated_at: string | null;
  updated_by: string | null;
};

export type WorkspaceAISettingsUpdate = Partial<{
  provider: AIProvider | null;
  model: string | null;
  /** Write-only. "" removes the stored key. */
  api_key: string;
  features: Partial<AIFeatures>;
  per_user_limit: number;
}>;

export type AITestResult = {
  ok: boolean;
  latency_ms: number;
  models: string[];
  /** The server's pick from `models` (provider default / newest Gemini pro-or-flash). */
  suggested_model?: string | null;
  error?: string | null;
};

export type AIUsageRow = { requests: number; input_tokens: number; output_tokens: number };
export type AIUsageReport = {
  by_day: (AIUsageRow & { date: string })[];
  by_feature: (AIUsageRow & { feature: string })[];
  by_user: (AIUsageRow & { user_id: string | null; full_name?: string | null })[];
};

/** Strip Gemini's "models/" prefix so ids match what chat completions accept. */
export function cleanModelId(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

/**
 * The model to preselect after a successful test: the provider default when it's offered, and for
 * Gemini the newest chat model whose id contains "pro" or "flash" (pro wins a tie).
 */
export function pickDefaultModel(provider: AIProvider, models: string[]): string | null {
  const ids = models.map(cleanModelId);
  if (!ids.length) return AI_PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? null;
  if (provider === "gemini") {
    const skip = /(embed|tts|image|audio|live|vision|aqa|learnlm|thinking-exp)/i;
    const candidates = ids.filter((id) => /(pro|flash)/i.test(id) && !skip.test(id));
    const version = (id: string) => (id.match(/(\d+(?:\.\d+)*)/)?.[1] ?? "0").split(".").map(Number);
    const score = (id: string) => {
      const v = version(id);
      return (v[0] ?? 0) * 1e6 + (v[1] ?? 0) * 1e3 + (v[2] ?? 0);
    };
    const rank = (id: string) => (/preview|exp/i.test(id) ? 0 : 2) + (/pro/i.test(id) ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a) || rank(b) - rank(a) || a.length - b.length);
    return candidates[0] ?? ids[0];
  }
  const fallback = AI_PROVIDERS.find((p) => p.id === provider)?.defaultModel;
  if (fallback && ids.includes(fallback)) return fallback;
  return fallback ?? ids[0];
}

export type WorkspaceAIStatus = {
  enabled: boolean;
  provider: AIProvider | null;
  model: string | null;
  features: Partial<AIFeatures>;
  can_configure: boolean;
  /** The use_ai policy allows the viewer to use AI. */
  can_use?: boolean;
  agent_installed_channel_ids: string[];
  agent_installed_everywhere: boolean;
};

/** Is the Worklio AI app active in this channel (direct install, or an everywhere-install covering a public channel)? */
export function agentInstalledIn(status: WorkspaceAIStatus | null, channel: { id: string; kind: string }): {
  installed: boolean;
  viaEverywhere: boolean;
} {
  if (!status) return { installed: false, viaEverywhere: false };
  const direct = status.agent_installed_channel_ids.includes(channel.id);
  const viaEverywhere = status.agent_installed_everywhere && channel.kind === "public";
  return { installed: direct || viaEverywhere, viaEverywhere: viaEverywhere && !direct };
}

// --- REST calls ----------------------------------------------------------------------------

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const adminApi = {
  // settings
  getSettings: (ws: string) => api<WorkspaceSettings>(`/workspaces/${ws}/settings`),
  patchSettings: (ws: string, patch: WorkspaceSettingsPatch) =>
    api<WorkspaceSettings>(`/workspaces/${ws}/settings`, { method: "PATCH", ...json(patch) }),
  uploadIcon: (ws: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api<WorkspaceSettings | Record<string, unknown>>(`/workspaces/${ws}/icon`, { method: "POST", body: form });
  },
  removeIcon: (ws: string) => api<void>(`/workspaces/${ws}/icon`, { method: "DELETE" }),

  // members
  listMembers: (ws: string, params: { q?: string; role?: WorkspaceRole | ""; status?: MemberStatus }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.role) qs.set("role", params.role);
    if (params.status) qs.set("status", params.status);
    return api<AdminMember[]>(`/workspaces/${ws}/admin/members?${qs}`);
  },
  setRole: (ws: string, userId: string, role: WorkspaceRole) =>
    api<unknown>(`/workspaces/${ws}/members/${userId}`, { method: "PATCH", ...json({ role }) }),
  deactivate: (ws: string, userId: string) => api<unknown>(`/workspaces/${ws}/members/${userId}/deactivate`, { method: "POST" }),
  reactivate: (ws: string, userId: string) => api<unknown>(`/workspaces/${ws}/members/${userId}/reactivate`, { method: "POST" }),
  removeMember: (ws: string, userId: string) => api<void>(`/workspaces/${ws}/members/${userId}`, { method: "DELETE" }),
  transferOwnership: (ws: string, userId: string) =>
    api<unknown>(`/workspaces/${ws}/transfer-ownership`, { method: "POST", ...json({ user_id: userId }) }),
  addByEmail: (ws: string, email: string, role: WorkspaceRole) =>
    api<unknown>(`/workspaces/${ws}/members`, { method: "POST", ...json({ email, role }) }),

  // invite links
  listInviteLinks: (ws: string) => api<InviteLink[]>(`/workspaces/${ws}/invite-links`),
  createInviteLink: (ws: string, body: InviteLinkCreate) =>
    api<InviteLink>(`/workspaces/${ws}/invite-links`, { method: "POST", ...json(body) }),
  revokeInviteLink: (id: string) => api<void>(`/invite-links/${id}`, { method: "DELETE" }),
  previewInvite: (token: string) => api<InvitePreview>(`/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) =>
    api<{ workspace_id: string; already_member?: boolean }>(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }),

  // channels
  channelRoles: (channelId: string) => api<ChannelRoles>(`/channels/${channelId}/roles`),
  renameChannel: (channelId: string, name: string) =>
    api<unknown>(`/channels/${channelId}`, { method: "PATCH", ...json({ name }) }),
  archiveChannel: (channelId: string) => api<unknown>(`/channels/${channelId}/archive`, { method: "POST" }),
  unarchiveChannel: (channelId: string) => api<unknown>(`/channels/${channelId}/unarchive`, { method: "POST" }),
  setChannelRole: (channelId: string, userId: string, role: ChannelRole) =>
    api<unknown>(`/channels/${channelId}/members/${userId}`, { method: "PATCH", ...json({ role }) }),
  removeChannelMember: (channelId: string, userId: string) =>
    api<void>(`/channels/${channelId}/members/${userId}`, { method: "DELETE" }),

  // audit
  auditLog: async (ws: string, cursor: string | null, action: string): Promise<AuditPage> => {
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    if (action) qs.set("action", action);
    const res = await api<AuditPage | AuditEvent[]>(`/workspaces/${ws}/audit-log?${qs}`);
    return Array.isArray(res) ? { items: res, next_cursor: null } : { items: res.items ?? [], next_cursor: res.next_cursor ?? null };
  },

  // AI
  getAISettings: (ws: string) => api<WorkspaceAISettings>(`/workspaces/${ws}/ai/settings`),
  putAISettings: (ws: string, body: WorkspaceAISettingsUpdate) =>
    api<WorkspaceAISettings>(`/workspaces/${ws}/ai/settings`, { method: "PUT", ...json(body) }),
  testAI: (ws: string, body: { provider: AIProvider; model?: string; api_key?: string }) =>
    api<AITestResult>(`/workspaces/${ws}/ai/test`, { method: "POST", ...json(body) }),
  aiUsage: (ws: string, days: number) => api<AIUsageReport>(`/workspaces/${ws}/ai/usage?days=${days}`),
  getAIStatus: (ws: string) => api<WorkspaceAIStatus>(`/workspaces/${ws}/ai/status`),
  installAgent: (channelId: string) => api<unknown>(`/channels/${channelId}/apps/worklio`, { method: "POST" }),
  uninstallAgent: (channelId: string) => api<void>(`/channels/${channelId}/apps/worklio`, { method: "DELETE" }),
  installEverywhere: (ws: string) => api<unknown>(`/workspaces/${ws}/apps/worklio/install-everywhere`, { method: "POST" }),
  uninstallEverywhere: (ws: string) =>
    api<void>(`/workspaces/${ws}/apps/worklio/install-everywhere`, { method: "DELETE" }),
};

// --- Shared cached stores ------------------------------------------------------------------

type Entry<T> = { data: T | null; error: string; loading: boolean };

function createStore<T>(fetcher: (ws: string) => Promise<T>) {
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();
  const listeners = new Set<() => void>();
  const EMPTY: Entry<T> = { data: null, error: "", loading: true };
  const emit = () => listeners.forEach((fn) => fn());

  const load = (ws: string): Promise<T> => {
    const running = inflight.get(ws);
    if (running) return running;
    const p = fetcher(ws)
      .then((data) => {
        entries.set(ws, { data, error: "", loading: false });
        return data;
      })
      .catch((err) => {
        const prev = entries.get(ws);
        entries.set(ws, { data: prev?.data ?? null, error: adminErrorMessage(err), loading: false });
        throw err;
      })
      .finally(() => {
        inflight.delete(ws);
        emit();
      });
    inflight.set(ws, p);
    return p;
  };

  return {
    load,
    /** Replace the cached value (optimistic updates). */
    set(ws: string, fn: (prev: T | null) => T | null) {
      const prev = entries.get(ws);
      entries.set(ws, { data: fn(prev?.data ?? null), error: "", loading: false });
      emit();
    },
    get: (ws: string): Entry<T> => entries.get(ws) ?? EMPTY,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

type Store<T> = ReturnType<typeof createStore<T>>;

function useStoreEntry<T>(store: Store<T>, ws: string, enabled: boolean): Entry<T> {
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(ws),
    () => store.get(""),
  );
  useEffect(() => {
    if (enabled && ws && store.get(ws).loading) store.load(ws).catch(() => {});
  }, [store, ws, enabled]);
  return entry;
}

export const settingsStore = createStore(adminApi.getSettings);
export const aiStatusStore = createStore(adminApi.getAIStatus);

/** Cached workspace settings (policies etc.), shared across the app. */
export function useWorkspaceSettings(ws: string) {
  const entry = useStoreEntry(settingsStore, ws, true);
  return {
    settings: entry.data,
    error: entry.error,
    loading: entry.loading && !entry.data,
    reload: () => settingsStore.load(ws),
  };
}

/** Cached per-workspace AI status (provider, features, agent installs). */
export function useWorkspaceAIStatus(ws: string, enabled = true) {
  const entry = useStoreEntry(aiStatusStore, ws, enabled);
  return {
    status: entry.data,
    error: entry.error,
    loading: entry.loading && !entry.data,
    reload: () => aiStatusStore.load(ws),
  };
}

/**
 * After AI settings, AI-related policies or app installs change: refresh our cached status and tell
 * the AI UI (lib/ai.ts listens for AI_SETTINGS_CHANGED_EVENT) to refetch its gate.
 */
export function notifyAIChanged(ws: string) {
  aiStatusStore.load(ws).catch(() => {});
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AI_SETTINGS_CHANGED_EVENT, { detail: { workspaceId: ws } }));
  }
}

// --- Formatting ----------------------------------------------------------------------------

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 45) return diff < 0 ? "just now" : "in a moment";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function fullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
