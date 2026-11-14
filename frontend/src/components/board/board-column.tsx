"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ArrowRight, Check, GripVertical, MoreHorizontal, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { Member } from "@/lib/api";
import { cn } from "@/lib/utils";

import { SortableCard } from "./board-card";
import { COLUMN_COLORS, type BoardCard, type BoardColumn as Column, type FieldDef } from "./types";
import { columnDot } from "./utils";

export const columnDropId = (columnId: string) => `column:${columnId}`;
export const COLUMN_SORT_PREFIX = "colsort:";
export const columnSortId = (columnId: string) => `${COLUMN_SORT_PREFIX}${columnId}`;

/** Drag overlay for a column being reordered. */
export function ColumnGhost({ column, count }: { column: Column; count: number }) {
  return (
    <div className="flex h-24 w-[min(280px,calc(100vw-3.5rem))] cursor-grabbing flex-col rounded-xl bg-muted/90 shadow-xl ring-2 ring-send/40 backdrop-blur dark:bg-muted/70">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <GripVertical className="size-4 text-muted-foreground" aria-hidden />
        <span className={cn("size-2.5 shrink-0 rounded-full", columnDot(column.color))} aria-hidden />
        <span className="truncate text-sm font-bold">{column.name}</span>
        <span className="rounded-full bg-background/80 px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">{count}</span>
      </div>
    </div>
  );
}

type Props = {
  column: Column;
  cards: BoardCard[];
  totalCount: number;
  memberById: Record<string, Member>;
  fields: FieldDef[];
  today: string;
  readOnly: boolean;
  /** Column reordering allowed (not while filtering-only views or read-only). */
  canReorder: boolean;
  filtered: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onAddCard: (title: string) => void;
  onOpenCard: (card: BoardCard) => void;
  onToggleComplete: (card: BoardCard) => void;
};

export function BoardColumnView({
  column,
  cards,
  totalCount,
  memberById,
  fields,
  today,
  readOnly,
  canReorder,
  filtered,
  isFirst,
  isLast,
  onRename,
  onRecolor,
  onDelete,
  onMove,
  onAddCard,
  onOpenCard,
  onToggleComplete,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column.id), data: { type: "column", columnId: column.id } });
  const {
    attributes: sortAttributes,
    listeners: sortListeners,
    setNodeRef: setSortRef,
    setActivatorNodeRef: setSortHandleRef,
    transform: sortTransform,
    transition: sortTransition,
    isDragging: columnDragging,
  } = useSortable({
    id: columnSortId(column.id),
    data: { type: "column-sort", columnId: column.id },
    disabled: !canReorder,
  });
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [adding, setAdding] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const cancelRename = useRef(false);
  const headingId = `board-col-${column.id}`;

  function commitRename(value: string) {
    setRenaming(false);
    const name = value.trim();
    if (name && name !== column.name) onRename(name.slice(0, 60));
  }

  return (
    <section
      ref={setSortRef}
      style={{ transform: CSS.Translate.toString(sortTransform), transition: sortTransition }}
      aria-labelledby={headingId}
      className={cn(
        "group/column flex max-h-full w-[min(280px,calc(100vw-3.5rem))] shrink-0 snap-start flex-col rounded-xl bg-muted/60 dark:bg-muted/30",
        columnDragging && "opacity-40",
      )}
    >
      <header className={cn("flex items-center gap-2 pt-2.5 pr-3 pb-1.5", canReorder ? "pl-1" : "pl-3")}>
        {canReorder && (
          <button
            ref={setSortHandleRef}
            type="button"
            {...sortAttributes}
            {...sortListeners}
            aria-label={`Reorder column ${column.name}`}
            aria-roledescription="sortable column"
            className="-mr-1 flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 opacity-60 transition-opacity group-hover/column:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing sm:opacity-0"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        )}
        <span className={cn("size-2.5 shrink-0 rounded-full", columnDot(column.color))} aria-hidden />
        {renaming ? (
          <Input
            ref={renameRef}
            autoFocus
            defaultValue={column.name}
            maxLength={60}
            aria-label="Column name"
            className="h-7 flex-1 text-sm font-bold"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              if (cancelRename.current) {
                cancelRename.current = false;
                setRenaming(false);
              } else commitRename(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h3 id={headingId} className="min-w-0 truncate text-sm font-bold">
            {column.name}
          </h3>
        )}
        {!renaming && (
          <span className="rounded-full bg-background/80 px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">
            {filtered && cards.length !== totalCount ? `${cards.length}/${totalCount}` : totalCount}
            <span className="sr-only"> cards</span>
          </span>
        )}
        {!readOnly && !renaming && (
          <div className="ml-auto flex items-center">
            <Button variant="ghost" size="icon-xs" aria-label={`Add card to ${column.name}`} onClick={() => setAdding(true)}>
              <Plus />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label={`${column.name} column options`} />}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48" finalFocus={() => renameRef.current ?? true}>
                <DropdownMenuItem onClick={() => setRenaming(true)}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette className="size-4" /> Color
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-40">
                    {COLUMN_COLORS.map((c) => (
                      <DropdownMenuItem key={c.key} onClick={() => onRecolor(c.key)}>
                        <span className={cn("size-3 rounded-full", c.dot)} aria-hidden />
                        {c.label}
                        {(column.color ?? "slate") === c.key && <Check className="ml-auto" aria-label="Current" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={isFirst} onClick={() => onMove(-1)}>
                  <ArrowLeft /> Move left
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isLast} onClick={() => onMove(1)}>
                  <ArrowRight /> Move right
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={isFirst && isLast} onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete column
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </header>

      <SortableContext id={column.id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          aria-label={`${column.name} cards`}
          className={cn(
            "flex min-h-14 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg px-2 pt-1 pb-2 transition-colors",
            isOver && "bg-send/5",
          )}
        >
          {cards.map((card) => (
            <SortableCard
              key={card.id}
              columnId={column.id}
              card={card}
              assignee={card.assignee_id ? memberById[card.assignee_id] : undefined}
              fields={fields}
              memberById={memberById}
              today={today}
              readOnly={readOnly}
              onOpen={onOpenCard}
              onToggleComplete={readOnly ? undefined : onToggleComplete}
            />
          ))}
          {cards.length === 0 && !adding && (
            <li className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
              {filtered && totalCount > 0 ? "No matching cards" : readOnly ? "No cards" : "Drop cards here"}
            </li>
          )}
        </ul>
      </SortableContext>

      {!readOnly &&
        (adding ? (
          <AddCardForm
            onAdd={onAddCard}
            onClose={() => setAdding(false)}
            columnName={column.name}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold text-muted-foreground hover:bg-background/70 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Plus className="size-4" /> Add card
          </button>
        ))}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{column.name}”?</DialogTitle>
            <DialogDescription>
              {totalCount > 0
                ? `This column and its ${totalCount} card${totalCount === 1 ? "" : "s"} will be deleted for everyone. This can't be undone.`
                : "This column will be deleted for everyone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
            >
              Delete column
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AddCardForm({ onAdd, onClose, columnName }: { onAdd: (title: string) => void; onClose: () => void; columnName: string }) {
  const [title, setTitle] = useState("");

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = title.trim();
    if (!t) return onClose();
    onAdd(t.slice(0, 200));
    setTitle("");
  }

  return (
    <form onSubmit={submit} className="mx-2 mb-2 rounded-lg border bg-card p-2 shadow-xs">
      <textarea
        autoFocus
        value={title}
        maxLength={200}
        rows={2}
        aria-label={`New card title in ${columnName}`}
        placeholder="Card title…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        onBlur={(e) => {
          // Leaving the form with nothing typed closes it; clicks on the form's own buttons don't.
          if (!title.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null)) onClose();
        }}
        className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
      <div className="mt-1 flex items-center gap-1.5">
        <Button type="submit" size="sm" className="bg-send text-white hover:bg-send/90" disabled={!title.trim()}>
          Add card
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">Enter to add</span>
      </div>
    </form>
  );
}
