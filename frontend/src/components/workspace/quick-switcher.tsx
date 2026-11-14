"use client";

import { FileText, Hash, Loader2, Lock, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { NAV_ITEMS, NAV_ITEM_BY_ID, type NavItemId } from "@/components/views/nav-items";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { canvasApi, canvasHref, type Canvas } from "@/lib/canvas";
import { cn } from "@/lib/utils";

import { useWorkspace } from "./provider";

type Item =
  | { kind: "channel"; id: string; label: string; private: boolean; joined: boolean }
  | { kind: "person"; id: string; label: string; sub: string }
  | { kind: "search"; id: string; label: string }
  | { kind: "canvas"; id: string; label: string; emoji: string | null; sub: string }
  | { kind: "view"; id: NavItemId; label: string; sub: string };

/** ⌘K: jump to any channel, person, canvas or workspace view (Threads, Later…), or search messages. */
export function QuickSwitcher() {
  const ws = useWorkspace();
  const { switcherOpen, setSwitcherOpen } = ws;
  return (
    <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
      <DialogContent showCloseButton={false} className="top-[max(1rem,15dvh)] max-h-[calc(100dvh-max(1rem,15dvh)-1rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search or jump to</DialogTitle>
        {switcherOpen && <SwitcherBody />}
      </DialogContent>
    </Dialog>
  );
}

function SwitcherBody() {
  const ws = useWorkspace();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Canvases the user can open (fetched once per open; the switcher still works without them).
  const [canvases, setCanvases] = useState<Canvas[]>([]);

  useEffect(() => {
    let live = true;
    canvasApi.list(ws.workspaceId).then(
      (list) => live && setCanvases(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ws.workspaceId]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const channels: Item[] = ws.channels
      .filter((c) => c.kind !== "dm" && c.name.includes(term))
      .sort((a, b) => Number(b.is_member) - Number(a.is_member) || b.unread_count - a.unread_count)
      .map((c) => ({ kind: "channel", id: c.id, label: c.name, private: c.kind === "private", joined: c.is_member }));
    const people: Item[] = ws.members
      .filter((m) => m.full_name.toLowerCase().includes(term) || m.email?.toLowerCase().includes(term))
      .map((m) => ({ kind: "person", id: m.user_id, label: m.full_name, sub: m.email ?? "" }));
    const views: Item[] = NAV_ITEMS.filter(
      (v) => !term || v.label.toLowerCase().includes(term) || v.id.includes(term) || v.description.toLowerCase().includes(term),
    ).map((v) => ({ kind: "view", id: v.id, label: v.label, sub: v.description }));
    const channelName = (id: string | null) => (id ? ws.channels.find((c) => c.id === id)?.name : undefined);
    const docs: Item[] = canvases
      .filter((c) => !term || (c.title || "Untitled").toLowerCase().includes(term))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((c) => {
        const ch = channelName(c.channel_id);
        return {
          kind: "canvas",
          id: c.id,
          label: c.title || "Untitled",
          emoji: c.emoji,
          sub: c.is_channel_canvas && ch ? `Canvas in #${ch}` : "Canvas",
        };
      });
    // Typing a view's name ("thr", "later") puts it first; otherwise views follow channels and people.
    const viewFirst = !!term && views.some((v) => v.label.toLowerCase().startsWith(term));
    const list = viewFirst
      ? [...views.slice(0, 4), ...channels.slice(0, 6), ...people.slice(0, 6), ...docs.slice(0, 5)]
      : [
          ...channels.slice(0, 6),
          ...people.slice(0, 6),
          ...docs.slice(0, term ? 5 : 3),
          ...views.slice(0, term ? 4 : NAV_ITEMS.length),
        ];
    if (term) list.push({ kind: "search", id: "search", label: q.trim() });
    return list;
  }, [q, ws.channels, ws.members, canvases]);

  const choose = async (item: Item | undefined) => {
    if (!item || busy) return;
    if (item.kind === "person") {
      // Keep the switcher open until the DM exists, so a failure can be shown here.
      setError("");
      setBusy(true);
      try {
        await ws.openDM([item.id]);
      } catch (err) {
        setError(`Couldn't open a conversation with ${item.label}: ${(err as Error).message}`);
        setBusy(false);
        return;
      }
    }
    ws.setSwitcherOpen(false);
    ws.setSidebarOpen(false);
    if (item.kind === "channel") router.push(`/w/${ws.workspaceId}/c/${item.id}`);
    else if (item.kind === "canvas") router.push(canvasHref(ws.workspaceId, item.id));
    else if (item.kind === "view") router.push(NAV_ITEM_BY_ID[item.id].href(ws.workspaceId));
    else if (item.kind === "search") ws.setSearchQuery(item.label);
  };

  return (
    <div className="flex max-h-[inherit] min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4">
        {busy ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Search className="size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[active]);
            }
          }}
          placeholder={`Search ${ws.workspace?.name ?? ""} or jump to…`}
          enterKeyHint="go"
          className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none sm:text-[15px]"
        />
        <kbd className="hidden rounded border px-1.5 text-[10px] text-muted-foreground sm:inline">ESC</kbd>
        <button
          type="button"
          onClick={() => ws.setSwitcherOpen(false)}
          className="shrink-0 rounded-md px-2 py-1.5 text-sm font-bold text-muted-foreground hover:bg-muted sm:hidden"
        >
          Cancel
        </button>
      </div>
      {error && <p className="shrink-0 border-b px-4 py-2 text-sm text-destructive">{error}</p>}
      <div className="max-h-[50dvh] min-h-0 overflow-y-auto overscroll-contain p-2">
        {items.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Nothing matches.</p>}
        {items.map((item, i) => (
          <button
            key={`${item.kind}-${item.id}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(item)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[15px]",
              i === active && "bg-link text-white",
            )}
          >
            {item.kind === "channel" &&
              (item.private ? <Lock className="size-4 opacity-70" /> : <Hash className="size-4 opacity-70" />)}
            {item.kind === "person" && (
              <UserAvatar id={item.id} name={item.label} size="sm" online={ws.online.has(item.id)} ringClassName="border-transparent" />
            )}
            {item.kind === "search" && <Search className="size-4 opacity-70" />}
            {item.kind === "view" && <ViewIcon id={item.id} />}
            {item.kind === "canvas" &&
              (item.emoji ? (
                <span className="flex size-4 items-center justify-center text-sm leading-none" aria-hidden>
                  {item.emoji}
                </span>
              ) : (
                <FileText className="size-4 opacity-70" />
              ))}
            <span className="min-w-0 flex-1 truncate">
              {item.kind === "search" ? (
                <>
                  Search messages for <strong>“{item.label}”</strong>
                </>
              ) : (
                item.label
              )}
              {item.kind === "person" && item.id === ws.me?.id && <span className="opacity-70"> (you)</span>}
            </span>
            {item.kind === "channel" && !item.joined && <span className="text-xs opacity-70">Not joined</span>}
            {item.kind === "person" && <span className="truncate text-xs opacity-70">{item.sub}</span>}
            {(item.kind === "view" || item.kind === "canvas") && (
              <span className="hidden truncate text-xs opacity-70 sm:inline">{item.sub}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ViewIcon({ id }: { id: NavItemId }) {
  const Icon = NAV_ITEM_BY_ID[id].icon;
  return <Icon className="size-4 opacity-70" />;
}
