"use client";

/**
 * Client-only whiteboard (Excalidraw). Loaded through next/dynamic({ ssr: false }) from
 * ./whiteboard.tsx — never import this module directly from a server-rendered path.
 */
import "@excalidraw/excalidraw/index.css";

import { Excalidraw, MainMenu, exportToBlob, exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import type { ClipboardData } from "@excalidraw/excalidraw/clipboard";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { UIOptions } from "@excalidraw/excalidraw/types";
import {
  Check,
  CircleAlert,
  CloudOff,
  Download,
  FileImage,
  FileCode2,
  Loader2,
  Lock,
  PenLine,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { fetchWhiteboard } from "./api";
import { WhiteboardSync } from "./sync";
import type { SaveStatus, Whiteboard } from "./types";
import { collaboratorColor, downloadBlob, slug } from "./utils";

export type WhiteboardBoardProps = {
  channelId: string;
  /** Minimal header for embedding (e.g. the call window stage); fills its parent. */
  compact?: boolean;
  /** Force a theme instead of following the app's light/dark class. */
  theme?: "light" | "dark";
  className?: string;
};

/** Library/save/load menus don't apply to a shared channel board; images aren't synced. */
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: {
    changeViewBackgroundColor: true,
    clearCanvas: false,
    export: false,
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    toggleTheme: null,
  },
  tools: { image: false },
};

// --- theme: follow <html class="dark"> -----------------------------------------------------------
function subscribeTheme(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}
const getDark = () => document.documentElement.classList.contains("dark");
const getDarkServer = () => false;

function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeTheme, getDark, getDarkServer) ? "dark" : "light";
}

/** Opaque per-tab id so a tab can ignore its own echoed frames. */
function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Image files aren't synced between clients, so refuse pasted image elements. */
function onPaste(data: ClipboardData) {
  if (data.elements?.some((el) => el.type === "image")) {
    toast.info("Images aren't supported on the whiteboard yet.");
    return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------------

export default function WhiteboardBoard(props: WhiteboardBoardProps) {
  // Remount per channel so no scene/state leaks between boards.
  return <WhiteboardLoader key={props.channelId} {...props} />;
}

function WhiteboardLoader(props: WhiteboardBoardProps) {
  const { channelId, compact, className } = props;
  const [board, setBoard] = useState<Whiteboard | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchWhiteboard(channelId)
      .then((w) => {
        if (!live) return;
        setBoard(w);
        setError("");
      })
      .catch((err) => {
        if (live) setError(errorMessage(err, "Couldn't load the whiteboard"));
      });
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  if (board) return <Board {...props} initial={board} />;

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <BoardHeaderShell compact={compact} />
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:22px_22px]">
        {error ? (
          <div role="alert" className="mx-4 flex max-w-sm flex-col items-center gap-3 rounded-xl border bg-background/95 p-5 text-center shadow-sm">
            <CircleAlert className="size-6 text-destructive" aria-hidden />
            <div>
              <p className="text-sm font-semibold">Couldn&apos;t open the whiteboard</p>
              <p className="mt-1 text-[13px] text-muted-foreground">{error}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError("");
                setAttempt((n) => n + 1);
              }}
            >
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-[13px] text-muted-foreground shadow-sm">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            Loading whiteboard…
          </div>
        )}
      </div>
    </div>
  );
}

function Board({
  channelId,
  compact = false,
  theme: themeOverride,
  className,
  initial,
}: WhiteboardBoardProps & { initial: Whiteboard }) {
  const ws = useWorkspace();
  const channel = ws.channels.find((c) => c.id === channelId);
  const readOnly = channel?.is_archived ?? false;
  const channelName = channel ? ws.channelLabel(channel) : "this channel";
  const docTheme = useDocumentTheme();
  const theme = themeOverride ?? docTheme;
  const [confirmClear, setConfirmClear] = useState(false);

  const member = (userId: string) => {
    const m = ws.memberById[userId];
    return { name: m?.full_name || "Someone", avatarUrl: m?.avatar_url ?? null };
  };

  const [engine] = useState(
    () =>
      new WhiteboardSync({
        channelId,
        clientId: newClientId(),
        meId: ws.me?.id,
        initial,
        readOnly,
        send: ws.sendRealtime,
        member,
        onError: (m) => toast.error(m),
      }),
  );
  const [initialData] = useState(() => ({
    elements: restoreElements(initial.elements as unknown as ExcalidrawElement[], null),
    scrollToContent: true,
  }));

  useEffect(() => {
    engine.update({
      send: ws.sendRealtime,
      member,
      meId: ws.me?.id,
      readOnly,
      onError: (m) => toast.error(m),
    });
  });
  useEffect(() => engine.attach(), [engine]);
  useWorkspaceEvents((e) => engine.handleEvent(e));

  const rawStatus = useSyncExternalStore(engine.subscribe, engine.getStatus, engine.getStatus);
  const peers = useSyncExternalStore(engine.subscribe, engine.getPeers, engine.getPeers);
  const empty = useSyncExternalStore(engine.subscribe, engine.getEmpty, engine.getEmpty);
  const status: SaveStatus =
    rawStatus === "readonly" ? rawStatus : ws.connection !== "open" && rawStatus !== "error" ? "offline" : rawStatus;

  const fileBase = `whiteboard-${slug(channelName)}`;

  async function exportAs(kind: "png" | "svg") {
    const api = engine.getApi();
    if (!api) return;
    const elements = api.getSceneElements();
    if (!elements.length) {
      toast.info("Nothing to export yet — draw something first.");
      return;
    }
    const appState = {
      ...api.getAppState(),
      exportBackground: true,
      exportWithDarkMode: theme === "dark",
    };
    try {
      if (kind === "png") {
        const blob = await exportToBlob({
          elements,
          appState,
          files: api.getFiles(),
          mimeType: "image/png",
          exportPadding: 24,
        });
        downloadBlob(blob, `${fileBase}.png`);
      } else {
        const svg = await exportToSvg({ elements, appState, files: api.getFiles(), exportPadding: 24 });
        downloadBlob(new Blob([svg.outerHTML], { type: "image/svg+xml" }), `${fileBase}.svg`);
      }
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't export the whiteboard"));
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <BoardHeaderShell compact={compact}>
        {!compact && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{channelName}</span>}
        <SaveStatusPill status={status} compact={compact} />
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <PeerStack meId={ws.me?.id} meName={ws.me?.full_name ?? "You"} peerIds={peers.map((p) => p.userId)} />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size={compact ? "icon-sm" : "sm"} aria-label="Export whiteboard" />
              }
            >
              <Download />
              {!compact && <span className="hidden sm:inline">Export</span>}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => void exportAs("png")}>
                <FileImage /> Export as PNG
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportAs("svg")}>
                <FileCode2 /> Export as SVG
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size={compact ? "icon-sm" : "icon"}
                    aria-label="Clear board"
                    disabled={empty}
                    onClick={() => setConfirmClear(true)}
                    className="text-muted-foreground hover:text-destructive"
                  />
                }
              >
                <Trash2 />
              </TooltipTrigger>
              <TooltipContent side="bottom">Clear board</TooltipContent>
            </Tooltip>
          )}
        </div>
      </BoardHeaderShell>

      <div
        className={cn(
          "relative isolate min-h-0 flex-1 overflow-hidden",
          // Excalidraw's library sidebar and its own avatar list duplicate our header; hide them.
          "[&_.default-sidebar-trigger]:hidden [&_.UserList__wrapper]:hidden",
        )}
      >
        <div className="absolute inset-0">
          <Excalidraw
            excalidrawAPI={engine.setApi}
            initialData={initialData}
            onChange={engine.onChange}
            onPointerUpdate={engine.onPointerUpdate}
            onPaste={onPaste}
            theme={theme}
            viewModeEnabled={readOnly}
            UIOptions={UI_OPTIONS}
            name={fileBase}
            autoFocus={false}
            handleKeyboardGlobally={false}
          >
            <MainMenu>
              <MainMenu.Item icon={<FileImage className="size-4" />} onSelect={() => void exportAs("png")}>
                Export as PNG
              </MainMenu.Item>
              <MainMenu.Item icon={<FileCode2 className="size-4" />} onSelect={() => void exportAs("svg")}>
                Export as SVG
              </MainMenu.Item>
              {!readOnly && (
                <MainMenu.Item icon={<Trash2 className="size-4" />} onSelect={() => setConfirmClear(true)}>
                  Clear board
                </MainMenu.Item>
              )}
              <MainMenu.Separator />
              <MainMenu.DefaultItems.Help />
              {!readOnly && <MainMenu.DefaultItems.ChangeCanvasBackground />}
            </MainMenu>
          </Excalidraw>
        </div>
        <EmptyHint show={empty} readOnly={readOnly} channelName={channelName} compact={compact} />
      </div>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear the whiteboard?</DialogTitle>
            <DialogDescription>
              This removes every shape for everyone in {channelName}. You can undo it right after with{" "}
              <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">⌘/Ctrl Z</kbd>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                engine.clear();
                setConfirmClear(false);
              }}
            >
              <Trash2 /> Clear board
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- pieces ---------------------------------------------------------------------------------------

function BoardHeaderShell({ compact, children }: { compact?: boolean; children?: React.ReactNode }) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-2 border-b bg-background/95 supports-backdrop-filter:backdrop-blur",
        compact ? "h-10 px-2" : "h-12 px-3 sm:px-4",
      )}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-sky-500 text-white shadow-sm",
          compact ? "size-6" : "size-7",
        )}
        aria-hidden
      >
        <PenLine className={compact ? "size-3.5" : "size-4"} />
      </span>
      <h2 className={cn("shrink-0 font-semibold tracking-tight", compact ? "text-[13px]" : "text-sm")}>Whiteboard</h2>
      {children}
    </header>
  );
}

const STATUS: Record<SaveStatus, { label: string; icon: React.ReactNode; tone: string }> = {
  saved: { label: "Saved", icon: <Check className="size-3" />, tone: "text-emerald-600 dark:text-emerald-400" },
  saving: {
    label: "Saving…",
    icon: <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />,
    tone: "text-muted-foreground",
  },
  offline: { label: "Offline", icon: <CloudOff className="size-3" />, tone: "text-amber-600 dark:text-amber-400" },
  error: { label: "Not saved", icon: <CircleAlert className="size-3" />, tone: "text-destructive" },
  readonly: { label: "Read-only", icon: <Lock className="size-3" />, tone: "text-muted-foreground" },
};

function SaveStatusPill({ status, compact }: { status: SaveStatus; compact?: boolean }) {
  const s = STATUS[status];
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent bg-muted/60 px-2 py-0.5 text-[11px] font-medium transition-colors",
        s.tone,
      )}
      title={s.label}
    >
      {s.icon}
      <span className={cn(compact && "sr-only sm:not-sr-only")}>{s.label}</span>
    </span>
  );
}

const MAX_AVATARS = 4;

function PeerStack({
  meId,
  meName,
  peerIds,
}: {
  meId: string | undefined;
  meName: string;
  peerIds: string[];
}) {
  const { memberById } = useWorkspace();
  const ids = [...(meId ? [meId] : []), ...peerIds];
  if (ids.length <= 1) return null;
  const shown = ids.slice(0, MAX_AVATARS);
  const extra = ids.length - shown.length;
  const others = peerIds.length;
  return (
    <div
      className="flex items-center"
      aria-label={`${others} other ${others === 1 ? "person" : "people"} on this whiteboard`}
      role="group"
    >
      <div className="flex -space-x-1.5">
        {shown.map((id) => {
          const name = id === meId ? `${meName} (you)` : (memberById[id]?.full_name ?? "Someone");
          const color = collaboratorColor(id).background;
          return (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <span
                    className="relative inline-flex rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90"
                    style={{ boxShadow: `0 0 0 2px var(--background), 0 0 0 3.5px ${color}` }}
                    tabIndex={0}
                  />
                }
              >
                <UserAvatar id={id} name={id === meId ? meName : name} size="md" />
              </TooltipTrigger>
              <TooltipContent side="bottom">{name}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {extra > 0 && (
        <span className="ml-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  );
}

function EmptyHint({
  show,
  readOnly,
  channelName,
  compact,
}: {
  show: boolean;
  readOnly: boolean;
  channelName: string;
  compact?: boolean;
}) {
  return (
    <div
      aria-hidden={!show}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-1/2 z-[5] flex -translate-y-1/2 justify-center px-6 transition-[opacity,transform] duration-300 motion-reduce:transition-none",
        show ? "opacity-100" : "translate-y-[-40%] opacity-0",
      )}
    >
      <div className="flex max-w-sm flex-col items-center text-center">
        <span className="mb-3 grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-500/15 to-sky-500/15 text-violet-600 ring-1 ring-violet-500/20 dark:text-violet-300">
          <PenLine className="size-5" />
        </span>
        <p className={cn("font-semibold tracking-tight text-foreground", compact ? "text-sm" : "text-base")}>
          {readOnly ? "This whiteboard is empty" : "Sketch it out together"}
        </p>
        {!readOnly && (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Pick a tool above and start drawing — everyone in {channelName} sees it live.
            <span className="hidden sm:inline">
              {" "}
              Press <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">R</kbd> for a rectangle,{" "}
              <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">P</kbd> to draw,{" "}
              <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">K</kbd> for the laser.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
