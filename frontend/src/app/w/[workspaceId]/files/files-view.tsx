"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  ExternalLink,
  FileAudio,
  FileImage,
  Files,
  FileText,
  FileVideo,
  LayoutGrid,
  List,
  Mic,
  Play,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ChannelIcon } from "@/components/views/message-snippet";
import { usePaged } from "@/components/views/use-paged";
import { SELECTED_ROW, useListNav } from "@/components/views/use-list-nav";
import { Chip, EmptyState, ErrorBlock, KeyHint, LoadMore, LoadingList, ViewHeader, ViewPage } from "@/components/views/view-shell";
import { isAudioAttachment, isVideoAttachment } from "@/components/voice/media";
import { VideoClipAttachment } from "@/components/voice/video-clip-player";
import { VoiceAttachment } from "@/components/voice/voice-player";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { dayLabel, formatBytes } from "@/lib/messages";
import { fileMatches, filesOfMessage, productivity, type FileType, type WorkspaceFile } from "@/lib/productivity";
import { cn } from "@/lib/utils";

const TYPES: { key: FileType; label: string; icon: LucideIcon }[] = [
  { key: "all", label: "All", icon: Files },
  { key: "images", label: "Images", icon: FileImage },
  { key: "videos", label: "Videos", icon: FileVideo },
  { key: "audio", label: "Audio", icon: FileAudio },
  { key: "documents", label: "Documents", icon: FileText },
  { key: "recordings", label: "Recordings", icon: Clapperboard },
];

// --- Grid/list preference (per browser) ---
type Layout = "grid" | "list";
const LAYOUT_KEY = "worklio.files.layout";
const layoutListeners = new Set<() => void>();
const layoutStore = {
  subscribe(fn: () => void) {
    layoutListeners.add(fn);
    return () => {
      layoutListeners.delete(fn);
    };
  },
  get(): Layout {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  },
  set(l: Layout) {
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // private mode: just don't remember it
    }
    layoutListeners.forEach((fn) => fn());
  },
};
const serverLayout = (): Layout => "grid";

const isImage = (f: WorkspaceFile) => f.content_type.startsWith("image/");
const previewable = (f: WorkspaceFile) => isImage(f) || isVideoAttachment(f) || isAudioAttachment(f);

function FileIcon({ file: f, className }: { file: WorkspaceFile; className?: string }) {
  if (f.kind === "voice") return <Mic className={className} />;
  if (f.kind === "screen_recording" || f.kind === "video_clip") return <Clapperboard className={className} />;
  if (isImage(f)) return <FileImage className={className} />;
  if (isVideoAttachment(f)) return <FileVideo className={className} />;
  if (isAudioAttachment(f)) return <FileAudio className={className} />;
  return <FileText className={className} />;
}

function fileTitle(f: WorkspaceFile): string {
  if (f.kind === "voice") return "Voice message";
  if (f.kind === "video_clip") return "Video clip";
  if (f.kind === "screen_recording") return "Screen recording";
  return f.filename;
}

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE");

const fileHref = (ws: string, f: WorkspaceFile) =>
  `/w/${ws}/c/${f.channel_id}?${new URLSearchParams({ msg: f.message_id })}`;

export function FilesView() {
  const ws = useWorkspace();
  const layout = useSyncExternalStore(layoutStore.subscribe, layoutStore.get, serverLayout);
  const [type, setType] = useState<FileType>("all");
  const [userId, setUserId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const paged = usePaged(
    `${ws.workspaceId}:${type}:${userId ?? ""}:${channelId ?? ""}:${q}`,
    (cursor) => productivity.files(ws.workspaceId, { type, userId, channelId, q, cursor }),
    (f: WorkspaceFile) => f.id,
  );
  const items = paged.items;
  const filtered = type !== "all" || !!userId || !!channelId || !!q;

  // Live updates: new uploads that pass the current filters slide in at the top right away, then a debounced
  // refetch of the first page reconciles (fresh presigned URLs, server-side visibility) without dropping
  // pages already loaded below.
  const filtersRef = useRef({ type, userId, channelId, q });
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    filtersRef.current = { type, userId, channelId, q };
  });
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );
  const { setItems: setFiles } = paged;
  const syncHead = () => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      const f = filtersRef.current;
      productivity
        .files(ws.workspaceId, { ...f, cursor: null })
        .then((p) => {
          const cur = filtersRef.current;
          if (cur.type !== f.type || cur.userId !== f.userId || cur.channelId !== f.channelId || cur.q !== f.q) return;
          const head = new Map(p.items.map((x) => [x.id, x]));
          setFiles((list) => {
            const seen = new Set(list.map((x) => x.id));
            const fresh = p.items.filter((x) => !seen.has(x.id));
            // Refresh rows we already show (new presigned URLs) and put anything new on top.
            return [...fresh, ...list.map((x) => head.get(x.id) ?? x)];
          });
        })
        .catch(() => {});
    }, 500);
  };

  useWorkspaceEvents((e) => {
    if (e.type === "resync") paged.reload(true);
    else if (e.type === "message.deleted") setFiles((list) => list.filter((f) => f.message_id !== e.message_id));
    else if (e.type === "message.created" && e.message.attachments?.length && e.message.workspace_id === ws.workspaceId) {
      const incoming = filesOfMessage(e.message).filter((f) => fileMatches(f, filtersRef.current));
      if (incoming.length) {
        setFiles((list) => {
          const seen = new Set(list.map((x) => x.id));
          return [...incoming.filter((x) => !seen.has(x.id)), ...list];
        });
        syncHead();
      }
    } else if (e.type === "message.updated" && e.message.deleted_at) {
      setFiles((list) => list.filter((f) => f.message_id !== e.message.id));
    }
  });

  const openFile = (f: WorkspaceFile) => {
    if (previewable(f)) setPreview(f.id);
    else window.open(f.url, "_blank", "noopener,noreferrer");
  };

  const nav = useListNav({
    scope: "files",
    count: items?.length ?? 0,
    onOpen: (i) => items?.[i] && openFile(items[i]),
  });

  const memberChannels = ws.channels.filter((c) => c.is_member);
  const person = userId ? ws.memberById[userId] : null;
  const channel = channelId ? ws.channels.find((c) => c.id === channelId) : null;
  const clearAll = () => {
    setType("all");
    setUserId(null);
    setChannelId(null);
    setQuery("");
    setQ("");
  };

  return (
    <ViewPage label="Files">
      <ViewHeader
        icon={Files}
        title="Files"
        subtitle="Everything shared in your conversations"
        actions={
          <div role="group" aria-label="Layout" className="flex rounded-lg border p-0.5">
            {(["grid", "list"] as const).map((l) => (
              <button
                key={l}
                aria-pressed={layout === l}
                onClick={() => layoutStore.set(l)}
                aria-label={l === "grid" ? "Grid view" : "List view"}
                title={l === "grid" ? "Grid view" : "List view"}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md",
                  layout === l ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l === "grid" ? <LayoutGrid className="size-4" /> : <List className="size-4" />}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex flex-col gap-2 px-3 pb-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search files by name"
                aria-label="Search files"
                className="pl-8"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className={filterBtn(!!person)}>
                {person ? <UserAvatar id={person.user_id} name={person.full_name} size="xs" /> : null}
                <span className="max-w-32 truncate">{person ? person.full_name : "From anyone"}</span>
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-60">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Shared by</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setUserId(null)}>Anyone</DropdownMenuItem>
                  {ws.me && (
                    <DropdownMenuItem onClick={() => setUserId(ws.me!.id)}>
                      <UserAvatar id={ws.me.id} name={ws.me.full_name} size="xs" /> You
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                {ws.members
                  .filter((m) => m.user_id !== ws.me?.id)
                  .sort((a, b) => a.full_name.localeCompare(b.full_name))
                  .map((m) => (
                    <DropdownMenuItem key={m.user_id} onClick={() => setUserId(m.user_id)}>
                      <UserAvatar id={m.user_id} name={m.full_name} size="xs" />
                      <span className="truncate">{m.full_name}</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger className={filterBtn(!!channel)}>
                {channel && <ChannelIcon channel={channel} />}
                <span className="max-w-32 truncate">{channel ? ws.channelLabel(channel) : "In any conversation"}</span>
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Shared in</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setChannelId(null)}>Any conversation</DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                {memberChannels.map((c) => (
                  <DropdownMenuItem key={c.id} onClick={() => setChannelId(c.id)}>
                    <ChannelIcon channel={c} />
                    <span className="truncate">{ws.channelLabel(c)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="-mx-3 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:px-0">
            {TYPES.map((t) => (
              <Chip key={t.key} active={type === t.key} onClick={() => setType(t.key)}>
                <t.icon className="size-3.5" /> {t.label}
              </Chip>
            ))}
            {filtered && (
              <button onClick={clearAll} className="ml-1 inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-link hover:underline">
                <X className="size-3.5" /> Clear filters
              </button>
            )}
            <span className="ml-auto shrink-0">
              <KeyHint>to preview</KeyHint>
            </span>
          </div>
        </div>
      </ViewHeader>

      <div className="flex-1 overflow-y-auto">
        {paged.error && <ErrorBlock message={paged.error} onRetry={() => paged.reload()} />}
        {!items && !paged.error && (layout === "grid" ? <GridSkeleton /> : <LoadingList />)}
        {items?.length === 0 && (
          <EmptyState
            icon={filtered ? Search : Files}
            title={filtered ? "No matching files" : "No files yet"}
            action={
              filtered ? (
                <button onClick={clearAll} className="rounded-md border px-3 py-1.5 text-sm font-bold hover:bg-muted">
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {filtered
              ? "Try a different name, type, person or conversation."
              : "Images, documents, voice messages and recordings shared in your conversations will collect here."}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <>
            {layout === "grid" ? (
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 sm:p-5">
                {items.map((f, i) => (
                  <FileCard key={f.id} file={f} navProps={nav.rowProps(i)} onOpen={() => openFile(f)} onFocus={() => nav.setIndex(i)} />
                ))}
              </div>
            ) : (
              <ul role="list">
                {items.map((f, i) => (
                  <li key={f.id}>
                    <FileRow file={f} navProps={nav.rowProps(i)} onOpen={() => openFile(f)} onFocus={() => nav.setIndex(i)} />
                  </li>
                ))}
              </ul>
            )}
            <LoadMore hasMore={paged.hasMore} loading={paged.loadingMore} error={paged.moreError} onMore={paged.loadMore} />
          </>
        )}
      </div>

      <PreviewDialog files={items ?? []} id={preview} onChange={setPreview} />
    </ViewPage>
  );
}

const filterBtn = (active: boolean) =>
  cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold hover:bg-muted aria-expanded:bg-muted",
    active && "border-tab/50 bg-mention/50",
  );

function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3 sm:p-5">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="animate-pulse overflow-hidden rounded-lg border" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="h-24 bg-muted sm:h-28" />
          <div className="space-y-1.5 p-2.5">
            <div className="h-3 w-3/4 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

type Ws = ReturnType<typeof useWorkspace>;

function fileMeta(ws: Ws, f: WorkspaceFile) {
  const channel = ws.channels.find((c) => c.id === f.channel_id);
  return {
    uploader: ws.memberById[f.uploader_id]?.full_name ?? "Someone",
    where: channel ? (channel.kind === "dm" ? ws.channelLabel(channel) : `#${channel.name}`) : "a conversation",
    jump: fileHref(ws.workspaceId, f),
  };
}

function FileThumb({ file: f, className }: { file: WorkspaceFile; className?: string }) {
  if (isImage(f))
    return (
      // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
      <img src={f.url} alt="" loading="lazy" className={cn("size-full object-cover", className)} />
    );
  const video = isVideoAttachment(f);
  return (
    <span className={cn("relative flex size-full items-center justify-center", className)}>
      <FileIcon file={f} className={cn("size-9", video ? "text-violet-600" : isAudioAttachment(f) ? "text-emerald-600" : "text-sky-600")} />
      {!video && !isAudioAttachment(f) && (
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-background/80 px-1 text-[10px] font-bold text-muted-foreground">
          {ext(f.filename)}
        </span>
      )}
      {(video || isAudioAttachment(f)) && (
        <span className="absolute right-2 bottom-2 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
          <Play className="size-3 fill-current" />
        </span>
      )}
    </span>
  );
}

function FileActions({ file: f, jump }: { file: WorkspaceFile; jump: string }) {
  return (
    <>
      <a
        href={f.url}
        download={f.filename}
        target="_blank"
        rel="noreferrer"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Download ${f.filename}`}
        title="Download"
        onClick={(e) => e.stopPropagation()}
      >
        <Download className="size-4" />
      </a>
      <Link
        href={jump}
        scroll={false}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Show in conversation"
        title="Show in conversation"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="size-4" />
      </Link>
    </>
  );
}

type ItemProps = { file: WorkspaceFile; navProps: Record<string, unknown>; onOpen: () => void; onFocus: () => void };

function FileCard({ file: f, navProps, onOpen, onFocus }: ItemProps) {
  const meta = fileMeta(useWorkspace(), f);
  return (
    <div
      {...navProps}
      className="group overflow-hidden rounded-lg border bg-background transition-shadow hover:shadow-md data-[selected]:ring-2 data-[selected]:ring-tab"
    >
      <button
        type="button"
        onClick={onOpen}
        onFocus={onFocus}
        className="block h-24 w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:h-28"
        aria-label={`${previewable(f) ? "Preview" : "Open"} ${fileTitle(f)}`}
      >
        <FileThumb file={f} />
      </button>
      <div className="flex items-start gap-1 p-2 sm:p-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold" title={f.filename}>
            {fileTitle(f)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {meta.uploader} · {dayLabel(f.created_at)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {meta.where} · {formatBytes(f.size)}
          </div>
        </div>
        <div className="-mr-1 flex shrink-0 flex-col opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          <FileActions file={f} jump={meta.jump} />
        </div>
      </div>
    </div>
  );
}

function FileRow({ file: f, navProps, onOpen, onFocus }: ItemProps) {
  const meta = fileMeta(useWorkspace(), f);
  return (
    <div {...navProps} className={cn("group flex items-center gap-3 border-b px-4 py-2 hover:bg-muted/40 sm:px-5", SELECTED_ROW)}>
      <button
        type="button"
        onClick={onOpen}
        onFocus={onFocus}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="size-10 shrink-0 overflow-hidden rounded-md border bg-muted">
          <FileThumb file={f} className="[&>svg]:size-5 [&>span]:hidden" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold" title={f.filename}>
            {fileTitle(f)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {meta.uploader} · {meta.where} · {dayLabel(f.created_at)}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:block">{formatBytes(f.size)}</span>
      </button>
      <div className="flex shrink-0 items-center">
        <FileActions file={f} jump={meta.jump} />
      </div>
    </div>
  );
}

/** Lightbox: images, video clips and voice messages, with ← / → between previewable files. */
function PreviewDialog({ files, id, onChange }: { files: WorkspaceFile[]; id: string | null; onChange: (id: string | null) => void }) {
  const list = files.filter(previewable);
  const index = id ? list.findIndex((f) => f.id === id) : -1;
  const f = index >= 0 ? list[index] : null;
  const ws = useWorkspace();
  const meta = f ? fileMeta(ws, f) : null;
  const go = (step: number) => {
    if (!list.length || index < 0) return;
    onChange(list[(index + step + list.length) % list.length].id);
  };

  return (
    <Dialog open={!!f} onOpenChange={(o) => !o && onChange(null)}>
      <DialogContent
        className="w-[min(100%-1rem,64rem)] gap-3 p-3 sm:max-w-none sm:p-4"
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest("input, textarea, [role=slider]")) return;
          if (e.key === "ArrowRight") go(1);
          else if (e.key === "ArrowLeft") go(-1);
        }}
      >
        {f && (
          <>
            <div className="flex items-center gap-2 pr-8">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-base font-black">{fileTitle(f)}</DialogTitle>
                <p className="truncate text-xs text-muted-foreground">
                  {meta?.uploader} · {meta?.where} · {dayLabel(f.created_at)} · {formatBytes(f.size)}
                </p>
              </div>
              {meta && <FileActions file={f} jump={meta.jump} />}
            </div>
            <div className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-muted/40">
              {isImage(f) ? (
                // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
                <img src={f.url} alt={f.filename} className="max-h-[70dvh] max-w-full object-contain" />
              ) : isVideoAttachment(f) ? (
                <VideoClipAttachment attachment={f} className="w-full sm:w-full" />
              ) : (
                <div className="w-full max-w-md p-6">
                  <VoiceAttachment attachment={f} />
                </div>
              )}
              {list.length > 1 && (
                <>
                  <button
                    onClick={() => go(-1)}
                    aria-label="Previous file"
                    className="absolute top-1/2 left-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background"
                  >
                    <ChevronLeft className="size-5" />
                  </button>
                  <button
                    onClick={() => go(1)}
                    aria-label="Next file"
                    className="absolute top-1/2 right-2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background"
                  >
                    <ChevronRight className="size-5" />
                  </button>
                </>
              )}
            </div>
            {list.length > 1 && (
              <p className="text-center text-xs text-muted-foreground tabular-nums">
                {index + 1} of {list.length} · use ← → to browse
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
