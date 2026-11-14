"use client";

import { Copy, Ellipsis, ExternalLink, FileText, Globe, Hash, Lock, Plus, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CreateCanvasDialog } from "@/components/canvas/canvas-dialogs";
import { CanvasGlyph } from "@/components/canvas/canvas-editor";
import { timeAgo, useNow } from "@/components/canvas/doc-utils";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Chip, EmptyState, ErrorBlock, ViewHeader, ViewPage } from "@/components/views/view-shell";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { asCanvasEvent, canDeleteCanvas, canvasApi, canvasHref, type Canvas } from "@/lib/canvas";
import { copyText } from "@/lib/clipboard";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Filter = "all" | "mine" | "shared" | "channel";
type Sort = "updated" | "title" | "created";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mine", label: "Created by me" },
  { key: "shared", label: "Standalone" },
  { key: "channel", label: "Channel canvases" },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: "updated", label: "Last edited" },
  { key: "created", label: "Newest" },
  { key: "title", label: "Title" },
];

export function CanvasesView() {
  const ws = useWorkspace();
  const { workspaceId, me, isAdmin, channels, memberById } = ws;
  const router = useRouter();
  const [items, setItems] = useState<Canvas[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [serverQ, setServerQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [attempt, setAttempt] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Canvas | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reqSeq = useRef(0);
  const refetchTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(refetchTimer.current), []);
  const now = useNow(30_000);

  // Debounce the server-side search.
  useEffect(() => {
    const id = window.setTimeout(() => setServerQ(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  useEffect(() => {
    let live = true;
    const seq = ++reqSeq.current;
    canvasApi.list(workspaceId, serverQ).then(
      (list) => {
        if (!live || seq !== reqSeq.current) return;
        setItems(list);
        setStatus("ready");
        setError("");
      },
      (err) => {
        if (!live || seq !== reqSeq.current) return;
        setError(errorMessage(err, "Couldn't load canvases"));
        setStatus((s) => (s === "ready" ? s : "error"));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, serverQ, attempt]);

  useWorkspaceEvents((raw) => {
    if (raw.type === "resync") {
      setAttempt((n) => n + 1);
      return;
    }
    const e = asCanvasEvent(raw);
    if (!e) return;
    if (e.type === "canvases.changed") {
      // Created / shared / renamed / deleted somewhere: refetch (coalescing bursts).
      if (e.workspace_id !== workspaceId) return;
      window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => setAttempt((n) => n + 1), 400);
      return;
    }
    if (e.type === "canvas.deleted") setItems((list) => list.filter((c) => c.id !== e.canvas_id));
    else if (e.type === "canvas.updated" && e.canvas?.id) {
      const patch = e.canvas;
      setItems((list) => list.map((c) => (c.id === patch.id ? ({ ...c, ...patch } as Canvas) : c)));
    }
  });

  // "/" focuses search, "c" creates (when not typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input,textarea,[contenteditable=true],[role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "c") {
        e.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = items.filter((c) => {
      if (term && !c.title.toLowerCase().includes(term) && !(c.emoji ?? "").includes(term)) {
        // The server may match on content too; keep server results when the query matches what it searched.
        if (term !== serverQ.toLowerCase()) return false;
      }
      if (filter === "mine") return c.created_by === me?.id;
      if (filter === "shared") return !c.is_channel_canvas;
      if (filter === "channel") return c.is_channel_canvas;
      return true;
    });
    return list.sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
        : sort === "created"
          ? b.created_at.localeCompare(a.created_at)
          : b.updated_at.localeCompare(a.updated_at),
    );
  }, [items, q, serverQ, filter, sort, me?.id]);

  async function remove(c: Canvas) {
    const snapshot = items;
    setItems((list) => list.filter((x) => x.id !== c.id));
    setToDelete(null);
    try {
      await canvasApi.remove(c.id);
      toast.success(`Deleted “${c.title || "Untitled"}”`);
    } catch (err) {
      setItems(snapshot);
      toast.error(errorMessage(err, "Couldn't delete the canvas"));
    }
  }

  async function copyLink(c: Canvas) {
    try {
      await copyText(`${window.location.origin}${canvasHref(workspaceId, c.id)}`);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <ViewPage label="Canvases">
      <ViewHeader
        icon={FileText}
        title="Canvases"
        subtitle="Shared docs, edited together in real time"
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} className="bg-send text-white hover:bg-send/90" title="New canvas (C)">
            <Plus /> <span className="hidden sm:inline">New canvas</span>
            <span className="sm:hidden">New</span>
          </Button>
        }
      >
        <div className="flex flex-col gap-2 px-3 pb-2.5 sm:flex-row sm:items-center sm:px-5">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && q) {
                  e.preventDefault();
                  setQ("");
                }
              }}
              placeholder="Search canvases"
              aria-label="Search canvases"
              className="h-8 pr-8 pl-8"
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ("")}
                className="absolute top-1/2 right-1.5 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {FILTERS.map((f) => (
              <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </Chip>
            ))}
            <label className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-[13px] text-muted-foreground">
              <span className="sr-only sm:not-sr-only">Sort</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="h-7 rounded-md border bg-background px-1.5 text-[13px] font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </ViewHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" ? (
          <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-5 xl:grid-cols-3" aria-busy="true" aria-label="Loading canvases">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="animate-pulse rounded-xl border p-4" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="mb-3 size-10 rounded-lg bg-muted" />
                <div className="mb-2 h-4 w-2/3 rounded bg-muted" />
                <div className="h-3 w-1/3 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : status === "error" ? (
          <ErrorBlock
            message={error}
            onRetry={() => {
              setStatus("loading");
              setAttempt((n) => n + 1);
            }}
          />
        ) : shown.length === 0 ? (
          q.trim() || filter !== "all" ? (
            <EmptyState icon={Search} title="No matching canvases">
              Try a different search or filter.
            </EmptyState>
          ) : (
            <EmptyState
              icon={FileText}
              title="No canvases yet"
              action={
                <Button onClick={() => setCreateOpen(true)} className="bg-send text-white hover:bg-send/90">
                  <Plus /> New canvas
                </Button>
              }
            >
              Canvases are shared docs for notes, specs and plans — everyone edits together, live.
            </EmptyState>
          )
        ) : (
          <ul className="grid gap-3 p-3 sm:grid-cols-2 sm:p-5 xl:grid-cols-3" aria-label="Canvases">
            {shown.map((c) => {
              const channel = c.channel_id ? channels.find((ch) => ch.id === c.channel_id) : undefined;
              const AccessIcon = c.is_channel_canvas ? Hash : c.access === "private" ? Lock : Globe;
              const access = c.is_channel_canvas ? (channel ? channel.name : "Channel") : c.access === "private" ? "Private" : "Workspace";
              const editor = c.updated_by ?? c.created_by;
              const editorName = editor === me?.id ? "You" : (memberById[editor]?.full_name ?? "Someone");
              const deletable = canDeleteCanvas(c, me?.id, isAdmin);
              return (
                <li key={c.id} className="group/card relative">
                  <Link
                    href={canvasHref(workspaceId, c.id)}
                    className="flex h-full flex-col rounded-xl border bg-background p-4 transition-all outline-none hover:border-link/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <CanvasGlyph emoji={c.emoji} className="mb-3 size-10 text-[1.4rem]" />
                    <span className="line-clamp-2 pr-8 font-bold leading-snug">{c.title || "Untitled"}</span>
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <AccessIcon className="size-3" aria-hidden /> {access}
                    </span>
                    <span className="mt-auto flex items-center gap-1.5 pt-4 text-xs text-muted-foreground">
                      <UserAvatar id={editor} name={editorName} size="xs" />
                      <span className="truncate">
                        {editorName} · <time dateTime={c.updated_at}>{timeAgo(c.updated_at, now)}</time>
                      </span>
                    </span>
                  </Link>
                  <div className="absolute top-3 right-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${c.title || "Untitled"}`}
                            className={cn(
                              "opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 sm:group-focus-within/card:opacity-100 aria-expanded:opacity-100",
                            )}
                          />
                        }
                      >
                        <Ellipsis />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem onClick={() => router.push(canvasHref(workspaceId, c.id))}>
                          <ExternalLink /> Open
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void copyLink(c)}>
                          <Copy /> Copy link
                        </DropdownMenuItem>
                        {deletable && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => setToDelete(c)}>
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <CreateCanvasDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(c, templateId) => {
          setItems((list) => [c, ...list.filter((x) => x.id !== c.id)]);
          router.push(`${canvasHref(workspaceId, c.id)}${templateId ? `?template=${encodeURIComponent(templateId)}` : ""}`);
        }}
      />

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-lg font-black">Delete this canvas?</DialogTitle>
            <DialogDescription>
              “{toDelete?.title || "Untitled"}” and its comments will be permanently deleted for everyone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => toDelete && void remove(toDelete)}>
              <Trash2 /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ViewPage>
  );
}
