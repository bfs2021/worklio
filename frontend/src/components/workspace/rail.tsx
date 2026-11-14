"use client";

import { AtSign, Check, Home, LayoutGrid, LogOut, MessagesSquare, Palette, PanelLeft, Plus, UserRound } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAppearance } from "@/components/appearance-provider";

import { UserAvatar, initials } from "@/components/chat/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Workspace } from "@/lib/api";
import { signOut } from "@/lib/api";
import { refreshWorkspaceUnreads, switcherVisible, toggledSwitcher, useNavBadges, useWorkspaceUnreads } from "@/lib/sidebar";
import { cn } from "@/lib/utils";

import { useWorkspace } from "./provider";

export type SidebarView = "home" | "dms";

export function Rail({ view, onView }: { view: SidebarView; onView: (v: SidebarView) => void }) {
  const ws = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const { prefs, update } = useAppearance();
  const badges = useNavBadges();
  const unreads = useWorkspaceUnreads();
  const onActivity = pathname.endsWith("/activity");
  const showSwitcher = switcherVisible(prefs.show_workspace_switcher, ws.workspaces.length);
  const otherIds = ws.workspaces.filter((w) => w.id !== ws.workspaceId).map((w) => w.id).join(",");

  // Unread totals for the other workspaces' tiles: fetched lazily (mount + window focus), cached 60 s.
  useEffect(() => {
    if (!otherIds) return;
    const ids = otherIds.split(",");
    refreshWorkspaceUnreads(ids);
    const onFocus = () => refreshWorkspaceUnreads(ids);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [otherIds]);
  const dmUnread = ws.channels.filter((c) => c.kind === "dm").reduce((n, c) => n + c.unread_count, 0);
  // In the mobile sheet the rail sits beside the sidebar; leaving the page closes the sheet.
  const go = (href: string) => {
    ws.setSidebarOpen(false);
    router.push(href);
  };

  const nav = [
    {
      key: "home",
      label: "Home",
      icon: Home,
      active: !onActivity && view === "home",
      onClick: () => {
        onView("home");
        if (onActivity) router.push(`/w/${ws.workspaceId}`);
      },
    },
    {
      key: "dms",
      label: "DMs",
      icon: MessagesSquare,
      active: !onActivity && view === "dms",
      badge: dmUnread,
      onClick: () => {
        onView("dms");
        if (onActivity) router.push(`/w/${ws.workspaceId}`);
      },
    },
    {
      key: "activity",
      label: "Activity",
      icon: AtSign,
      active: onActivity,
      badge: badges.activity,
      onClick: () => go(`/w/${ws.workspaceId}/activity`),
    },
  ];

  return (
    <nav className="flex h-full w-[70px] shrink-0 flex-col items-center gap-3 pt-1 pb-3 text-chrome-foreground">
      <div className="flex min-h-0 shrink flex-col items-center gap-3 overflow-y-auto px-1 pt-1 pb-1 [scrollbar-width:none]">
        {!showSwitcher && ws.workspace && (
          <CompactSwitcher
            current={ws.workspace}
            workspaces={ws.workspaces}
            unreads={unreads}
            go={go}
            onShowSwitcher={() =>
              update({ show_workspace_switcher: toggledSwitcher(prefs.show_workspace_switcher, ws.workspaces.length) })
            }
          />
        )}
        {ws.workspaces
          .map((w, i) => ({ w, i }))
          .filter(() => showSwitcher)
          .map(({ w, i }) => {
            const current = w.id === ws.workspaceId;
            const count = current ? 0 : (unreads[w.id]?.count ?? 0);
            const hint = `${w.name}${i < 9 && showSwitcher ? ` (⌘${i + 1})` : ""}${count ? ` · ${count} unread` : ""}`;
            return (
              <button
                key={w.id}
                onClick={() => (current ? ws.setSidebarOpen(false) : go(`/w/${w.id}`))}
                title={hint}
                aria-label={current ? `${w.name} (current workspace)` : `Switch to ${hint}`}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-sm font-black transition",
                  current ? "bg-white text-chrome ring-2 ring-white/40 ring-offset-2 ring-offset-chrome" : "hover:bg-white/25",
                  w.icon_url && "bg-transparent",
                )}
              >
                {w.icon_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.icon_url} alt="" className="size-full rounded-lg object-cover" />
                ) : (
                  initials(w.name)
                )}
                {count > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-badge px-1 text-[10px] leading-4 font-bold text-badge-foreground ring-2 ring-chrome">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
      </div>

      <div className="mt-1 flex shrink-0 flex-col items-center gap-2">
        {nav.map((n) => (
          <button key={n.key} onClick={n.onClick} className="group flex flex-col items-center gap-0.5 text-[11px] font-bold">
            <span
              className={cn(
                "relative flex size-9 items-center justify-center rounded-lg transition",
                n.active ? "bg-chrome-hover ring-1 ring-white/20" : "group-hover:bg-chrome-hover",
              )}
            >
              <n.icon className="size-[18px]" />
              {!!n.badge && (
                <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-badge px-1 text-[10px] leading-4 text-badge-foreground">
                  {n.badge > 99 ? "99+" : n.badge}
                </span>
              )}
            </span>
            {n.label}
          </button>
        ))}
      </div>

      <div className="mt-auto flex shrink-0 flex-col items-center gap-3">
        {showSwitcher && (
        <button
          onClick={() => go("/new")}
          aria-label="Create a new workspace"
          title="Create a new workspace"
          className="flex size-9 items-center justify-center rounded-full bg-chrome-hover hover:bg-white/20"
        >
          <Plus className="size-5" />
        </button>
        )}
        {ws.me && (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Your profile">
              <UserAvatar id={ws.me.id} name={ws.me.full_name} online ringClassName="border-chrome" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" className="w-56">
              <div className="flex items-center gap-2.5 px-2 py-2">
                <UserAvatar id={ws.me.id} name={ws.me.full_name} size="md" online />
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">{ws.me.full_name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.me.email}</div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  ws.setSidebarOpen(false);
                  ws.setProfileOpen(true);
                }}
              >
                <UserRound className="size-4" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  ws.setSidebarOpen(false);
                  ws.setPreferencesOpen(true);
                }}
              >
                <Palette className="size-4" /> Preferences
                <span className="ml-auto text-xs text-muted-foreground">⌘,</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  ws.setSidebarOpen(false);
                  void signOut();
                  router.replace("/login");
                }}
              >
                <LogOut className="size-4" /> Sign out of Worklio
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </nav>
  );
}

function WorkspaceGlyph({ w, className }: { w: Workspace; className?: string }) {
  return w.icon_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={w.icon_url} alt="" className={cn("rounded-lg object-cover", className)} />
  ) : (
    <span className={cn("flex items-center justify-center rounded-lg font-black", className)}>{initials(w.name)}</span>
  );
}

/**
 * Switcher hidden (Slack-style): only the current workspace shows in the rail. Clicking it opens
 * a menu of every workspace; a dot flags unread messages in the others.
 */
function CompactSwitcher({
  current,
  workspaces,
  unreads,
  go,
  onShowSwitcher,
}: {
  current: Workspace;
  workspaces: Workspace[];
  unreads: Record<string, { count: number } | undefined>;
  go: (href: string) => void;
  onShowSwitcher: () => void;
}) {
  const othersUnread = workspaces.some((w) => w.id !== current.id && (unreads[w.id]?.count ?? 0) > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${current.name}: switch workspace${othersUnread ? " (unread messages in other workspaces)" : ""}`}
        title={current.name}
        className={cn(
          "relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-white text-sm font-black text-chrome ring-2 ring-white/40 ring-offset-2 ring-offset-chrome outline-none focus-visible:ring-white",
          current.icon_url && "bg-transparent",
        )}
      >
        <WorkspaceGlyph w={current} className="size-full text-sm" />
        {othersUnread && (
          <span aria-hidden className="absolute -top-1 -right-1 size-2.5 rounded-full bg-badge ring-2 ring-chrome" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={10} className="w-64">
        {workspaces.map((w, i) => {
          const isCurrent = w.id === current.id;
          const count = isCurrent ? 0 : (unreads[w.id]?.count ?? 0);
          return (
            <DropdownMenuItem key={w.id} onClick={() => !isCurrent && go(`/w/${w.id}`)}>
              <WorkspaceGlyph w={w} className="size-6 bg-muted text-[10px]" />
              <span className={cn("min-w-0 flex-1 truncate", count > 0 && "font-bold")}>{w.name}</span>
              {isCurrent ? (
                <Check className="size-4" />
              ) : count > 0 ? (
                <span className="rounded-full bg-badge px-1.5 text-[10px] leading-4 font-bold text-badge-foreground">
                  {count > 99 ? "99+" : count}
                </span>
              ) : i < 9 ? (
                <DropdownMenuShortcut>⌘{i + 1}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => go("/new")}>
          <LayoutGrid className="size-4" /> Create a new workspace
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onShowSwitcher}>
          <PanelLeft className="size-4" /> Show workspace switcher
          <DropdownMenuShortcut>⌘⇧S</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
