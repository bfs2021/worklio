"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { ListTree } from "lucide-react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { cn } from "@/lib/utils";

import type { CanvasPeer, SyncStatus } from "./types";

export type DocHeading = { level: number; text: string; pos: number };
export type DocStats = { headings: DocHeading[]; words: number; chars: number; empty: boolean };

const EMPTY_STATS: DocStats = { headings: [], words: 0, chars: 0, empty: true };

/** Headings (for the outline), word/character counts and emptiness, recomputed per transaction. */
export function useDocStats(editor: Editor | null): DocStats {
  const stats = useEditorState({
    editor,
    selector: ({ editor: e }): DocStats => {
      if (!e) return EMPTY_STATS;
      const { doc } = e.state;
      const headings: DocHeading[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name === "heading") {
          const text = node.textContent.trim();
          if (text) headings.push({ level: Number(node.attrs.level) || 1, text, pos });
          return false;
        }
        // Headings only live at the top level or inside simple containers.
        return node.isBlock && node.type.name !== "table" && node.type.name !== "codeBlock";
      });
      const text = doc.textBetween(0, doc.content.size, " ", " ");
      const words = text.split(/\s+/).filter(Boolean).length;
      return { headings, words, chars: text.replace(/\s/g, "").length, empty: e.isEmpty };
    },
  });
  return stats ?? EMPTY_STATS;
}

export function scrollToPos(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(pos + 1).run();
  } catch {
    // Position vanished (concurrent edit); scrolling was enough.
  }
}

/** Table of contents from the document headings. */
export function Outline({
  editor,
  headings,
  className,
}: {
  editor: Editor;
  headings: DocHeading[];
  className?: string;
}) {
  return (
    <nav aria-label="Outline" className={cn("text-[13px]", className)}>
      <p className="mb-2 flex items-center gap-1.5 px-2 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
        <ListTree className="size-3.5" aria-hidden /> Outline
      </p>
      {headings.length === 0 ? (
        <p className="px-2 text-xs leading-relaxed text-muted-foreground">Add headings to see an outline of this canvas.</p>
      ) : (
        <ul className="space-y-px">
          {headings.map((h) => (
            <li key={`${h.pos}-${h.text}`}>
              <button
                type="button"
                onClick={() => scrollToPos(editor, h.pos)}
                className={cn(
                  "block w-full truncate rounded-md py-1 pr-2 text-left text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  h.level === 1 && "pl-2 font-semibold text-foreground/85",
                  h.level === 2 && "pl-4",
                  h.level === 3 && "pl-6 text-[12.5px]",
                )}
                title={h.text}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** "Live · N editing" with the avatars of everyone else in the canvas. */
export function LivePresence({
  status,
  peers,
  meName,
}: {
  status: SyncStatus;
  peers: CanvasPeer[];
  meName: string;
}) {
  const shown = peers.slice(0, 4);
  const count = peers.length + 1;
  const names = peers.map((p) => p.name);
  const label =
    status === "live"
      ? peers.length
        ? `${meName} (you), ${names.join(", ")} editing`
        : "Only you are here"
      : status === "offline"
        ? "You're offline — edits are kept and will sync when you reconnect"
        : status === "denied"
          ? "Live sync stopped"
          : "Connecting to live session…";

  return (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite" title={label}>
      {status === "live" && shown.length > 0 && (
        <div className="flex items-center" aria-hidden>
          {shown.map((p, i) => (
            <span
              key={p.clientId}
              className={cn("rounded-[5px] ring-2", i > 0 && "-ml-1.5")}
              style={{ "--tw-ring-color": p.color } as React.CSSProperties}
            >
              <UserAvatar id={p.userId} name={p.name} size="sm" className="rounded" />
            </span>
          ))}
          {peers.length > shown.length && (
            <span className="-ml-1.5 inline-flex size-[18px] items-center justify-center rounded bg-muted text-[9px] font-bold ring-2 ring-background">
              +{peers.length - shown.length}
            </span>
          )}
        </div>
      )}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap",
          status === "live" ? "text-emerald-700 dark:text-emerald-400" : status === "offline" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
      >
        <span className="relative flex size-2" aria-hidden>
          {status === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:hidden" />}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              status === "live" ? "bg-emerald-500" : status === "offline" ? "bg-amber-500" : status === "denied" ? "bg-destructive" : "bg-muted-foreground/50",
            )}
          />
        </span>
        {status === "live" ? (
          <span>
            Live<span className="hidden sm:inline"> · {count} editing</span>
          </span>
        ) : status === "offline" ? (
          "Offline"
        ) : status === "denied" ? (
          "Not syncing"
        ) : (
          "Connecting…"
        )}
      </span>
    </div>
  );
}
