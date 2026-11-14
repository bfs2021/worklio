"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, ExternalLink, Link2, Loader2, MoreHorizontal, Pencil, Plus, SmilePlus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { EmojiPicker } from "@/components/chat/emoji-picker";
import { useWorkspaceEvents } from "@/components/workspace/provider";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { copyText } from "@/lib/clipboard";
import { asMessagingEvent, hostOf, messaging, normalizeUrl, type Bookmark } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const byPosition = (a: Bookmark, b: Bookmark) => a.position - b.position;

/** Links pinned under the channel header: add, edit, reorder by drag, open in a new tab. */
export function BookmarksBar({ channelId, readOnly }: { channelId: string; readOnly?: boolean }) {
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Bookmark | "new" | null>(null);

  useEffect(() => {
    let live = true;
    messaging
      .bookmarks(channelId)
      .then((list) => live && setItems([...list].sort(byPosition)))
      // Bookmarks are optional chrome: on failure just show the "Add a bookmark" affordance.
      .catch(() => live && setItems((cur) => cur ?? []));
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  useWorkspaceEvents((e) => {
    const me = asMessagingEvent(e);
    if (me?.type === "bookmarks.updated" && me.channel_id === channelId) setItems([...me.bookmarks].sort(byPosition));
    if (e.type === "resync") setAttempt((n) => n + 1);
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Space picks a bookmark up (Enter still opens the link).
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!items || !over || active.id === over.id) return;
    const from = items.findIndex((b) => b.id === active.id);
    const to = items.findIndex((b) => b.id === over.id);
    if (from < 0 || to < 0) return;
    const prev = items;
    const next = arrayMove(items, from, to).map((b, i) => ({ ...b, position: i + 1 }));
    setItems(next);
    try {
      // Positions are absolute: renumber every bookmark whose slot changed.
      const before = new Map(prev.map((b) => [b.id, b.position]));
      await Promise.all(
        next.filter((b) => before.get(b.id) !== b.position).map((b) => messaging.updateBookmark(b.id, { position: b.position })),
      );
    } catch (err) {
      setItems(prev);
      toast.error(`Couldn't reorder bookmarks: ${errorMessage(err)}`);
    }
  };

  const remove = async (b: Bookmark) => {
    if (!items) return;
    const prev = items;
    setItems(items.filter((x) => x.id !== b.id));
    try {
      await messaging.deleteBookmark(b.id);
      toast.success("Bookmark removed");
    } catch (err) {
      setItems(prev);
      toast.error(`Couldn't remove the bookmark: ${errorMessage(err)}`);
    }
  };

  if (items === null) return <div className="h-9 shrink-0 border-b" aria-hidden />;
  if (readOnly && items.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 [scrollbar-width:none] sm:px-4">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((b) => b.id)} strategy={horizontalListSortingStrategy} disabled={readOnly}>
          {items.map((b) => (
            <BookmarkChip key={b.id} bookmark={b} readOnly={readOnly} onEdit={() => setEditing(b)} onRemove={() => remove(b)} />
          ))}
        </SortableContext>
      </DndContext>
      {!readOnly && (
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Add a bookmark"
          aria-label="Add a bookmark"
        >
          <Plus className="size-3.5" />
          {items.length === 0 && <span>Add a bookmark</span>}
        </button>
      )}
      {editing && (
        <BookmarkDialog
          channelId={channelId}
          bookmark={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) =>
            setItems((list) => {
              const cur = list ?? [];
              return (cur.some((x) => x.id === saved.id) ? cur.map((x) => (x.id === saved.id ? saved : x)) : [...cur, saved]).sort(
                byPosition,
              );
            })
          }
        />
      )}
    </div>
  );
}

function BookmarkChip({
  bookmark: b,
  readOnly,
  onEdit,
  onRemove,
}: {
  bookmark: Bookmark;
  readOnly?: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: b.id });
  // A drop ends with a click on the link: swallow it so reordering doesn't open a tab.
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) {
      dragged.current = true;
      return;
    }
    // The trailing click (if any) fires right after the drop; forget the drag shortly after.
    const t = setTimeout(() => {
      dragged.current = false;
    }, 100);
    return () => clearTimeout(t);
  }, [isDragging]);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/bm flex h-7 max-w-56 shrink-0 items-center rounded-md hover:bg-muted",
        isDragging && "z-10 bg-muted shadow-md",
      )}
    >
      <a
        href={b.url}
        target="_blank"
        rel="noreferrer noopener"
        title={`${b.title} — ${b.url}`}
        {...attributes}
        {...listeners}
        // dnd-kit makes the node a "button" for a11y; it's a link that can also be dragged.
        role="link"
        aria-roledescription="draggable bookmark"
        draggable={false}
        onClick={(e) => {
          if (dragged.current) {
            e.preventDefault();
            dragged.current = false;
          }
        }}
        className="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2 text-[13px] font-bold text-foreground/85 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md"
      >
        {b.emoji ? <span className="text-sm leading-none">{b.emoji}</span> : <Link2 className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">{b.title}</span>
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/bm:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 data-popup-open:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Options for ${b.title}`}
        >
          <MoreHorizontal className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onClick={() => window.open(b.url, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="size-4" /> Open link
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              copyText(b.url)
                .then(() => toast.success("Link copied"))
                .catch((err) => toast.error(errorMessage(err, "Couldn't copy")))
            }
          >
            <Copy className="size-4" /> Copy link
          </DropdownMenuItem>
          {!readOnly && (
            <>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-4" /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2 className="size-4" /> Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function BookmarkDialog({
  channelId,
  bookmark,
  onClose,
  onSaved,
}: {
  channelId: string;
  bookmark: Bookmark | null;
  onClose: () => void;
  onSaved: (b: Bookmark) => void;
}) {
  const [url, setUrl] = useState(bookmark?.url ?? "");
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [emoji, setEmoji] = useState<string | null>(bookmark?.emoji ?? null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const normalized = normalizeUrl(url);
  const urlInvalid = url.trim().length > 0 && !normalized;
  const finalTitle = title.trim() || (normalized ? hostOf(normalized) : "");
  const valid = !!normalized && finalTitle.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !normalized || busy) return;
    setBusy(true);
    setError("");
    try {
      const data = { title: finalTitle.slice(0, 100), url: normalized, emoji };
      const saved = bookmark ? await messaging.updateBookmark(bookmark.id, data) : await messaging.addBookmark(channelId, data);
      onSaved(saved);
      toast.success(bookmark ? "Bookmark updated" : "Bookmark added");
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the bookmark"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-lg font-black">{bookmark ? "Edit bookmark" : "Add a bookmark"}</DialogTitle>
            <DialogDescription>Keep important links one click away for everyone in this conversation.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="bm-url" className="text-sm font-bold">
              Link
            </label>
            <Input
              id="bm-url"
              value={url}
              autoFocus
              inputMode="url"
              placeholder="https://example.com/roadmap"
              aria-invalid={urlInvalid || undefined}
              onChange={(e) => setUrl(e.target.value)}
            />
            {urlInvalid && <p className="text-xs text-destructive">Enter a valid http(s) link.</p>}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="bm-title" className="text-sm font-bold">
              Name
            </label>
            <div className="flex gap-2">
              <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border text-base hover:bg-muted"
                  aria-label={emoji ? `Icon ${emoji}, change` : "Pick an icon"}
                >
                  {emoji ?? <SmilePlus className="size-4 text-muted-foreground" />}
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <EmojiPicker
                    onPick={(e) => {
                      setEmoji(e);
                      setEmojiOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Input
                id="bm-title"
                value={title}
                maxLength={100}
                placeholder={normalized ? hostOf(normalized) : "Roadmap"}
                onChange={(e) => setTitle(e.target.value)}
              />
              {emoji && (
                <Button type="button" variant="ghost" size="icon" aria-label="Remove icon" onClick={() => setEmoji(null)}>
                  <X />
                </Button>
              )}
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy} className="bg-send text-white hover:bg-send/90">
              {busy && <Loader2 className="animate-spin" />}
              {bookmark ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
