"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlignLeft, CalendarDays, Check, MessageSquare } from "lucide-react";
import type { KeyboardEvent } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import type { Member } from "@/lib/api";
import { colorMeta, isEmptyValue, subtaskProgress } from "@/lib/lists";
import { cn } from "@/lib/utils";

import { FieldValueView, PriorityBadge, SubtaskBadge } from "./pieces";
import type { BoardCard, FieldDef } from "./types";
import { dueStatus, formatDue, labelColor } from "./utils";

type CardViewProps = {
  card: BoardCard;
  assignee: Member | undefined;
  today: string;
  fields: FieldDef[];
  memberById: Record<string, Member>;
  readOnly?: boolean;
  onToggleComplete?: (card: BoardCard) => void;
  overlay?: boolean;
};

const MAX_FIELD_CHIPS = 4;

export function DuePill({ due, today, completed }: { due: string; today: string; completed: boolean }) {
  const status = dueStatus(due, today, completed);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold",
        status === "overdue" && "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
        status === "soon" && "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
        (status === "later" || status === "done") && "bg-muted text-muted-foreground",
      )}
      title={status === "overdue" ? "Overdue" : status === "soon" ? "Due soon" : "Due date"}
    >
      <CalendarDays className="size-3" aria-hidden />
      {formatDue(due, today)}
      {status === "overdue" && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

export function LabelChip({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 max-w-full items-center truncate rounded-full px-2 text-[11px] font-semibold", labelColor(label), className)}>
      {label}
    </span>
  );
}

function CompleteToggle({
  card,
  disabled,
  onToggle,
  className,
}: {
  card: BoardCard;
  disabled: boolean;
  onToggle?: (card: BoardCard) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={card.completed}
      aria-label={card.completed ? `Mark "${card.title}" as not done` : `Mark "${card.title}" as done`}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.(card);
      }}
      className={cn(
        "mt-px flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default",
        card.completed
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-muted-foreground/50 text-transparent hover:border-emerald-600 hover:text-emerald-600",
        className,
      )}
    >
      <Check className="size-3" strokeWidth={3} aria-hidden />
    </button>
  );
}

/** Presentational card body; used both in the column list and in the drag overlay. */
export function CardView({
  card,
  assignee,
  today,
  fields,
  memberById,
  readOnly,
  onToggleComplete,
  overlay,
  toggleOutside,
}: CardViewProps & { toggleOutside?: boolean }) {
  const { done, total } = subtaskProgress(card);
  const filled = fields.filter((f) => !isEmptyValue(card.fields[f.id]));
  const chips = filled.slice(0, MAX_FIELD_CHIPS);
  const hasFooter = card.due_date || card.description || assignee || card.priority !== "none" || total > 0 || card.comment_count > 0;

  return (
    <div
      className={cn(
        "group/card overflow-hidden rounded-lg border bg-card p-2.5 text-left shadow-xs transition-shadow",
        overlay ? "rotate-2 cursor-grabbing shadow-xl ring-2 ring-send/40" : "hover:border-foreground/20 hover:shadow-md",
      )}
    >
      {card.cover_color && <div className={cn("-mx-2.5 -mt-2.5 mb-2.5 h-2", colorMeta(card.cover_color).cover)} aria-hidden />}
      <div className="flex items-start gap-2">
        {toggleOutside ? (
          <span className="mt-px size-4 shrink-0" aria-hidden />
        ) : (
          <CompleteToggle card={card} disabled={readOnly || !onToggleComplete} onToggle={onToggleComplete} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px] leading-snug font-semibold break-words",
            card.completed && "text-muted-foreground line-through",
          )}
        >
          {card.title}
        </span>
      </div>

      {card.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <LabelChip key={l} label={l} />
          ))}
        </div>
      )}

      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((f) =>
            f.type === "select" || f.type === "multi_select" ? (
              <FieldValueView key={f.id} field={f} value={card.fields[f.id]} memberById={memberById} showName />
            ) : (
              <span key={f.id} className="inline-flex h-5 max-w-full min-w-0 items-center rounded-md bg-muted px-1.5 text-[11px] font-medium">
                <FieldValueView field={f} value={card.fields[f.id]} memberById={memberById} showName className="min-w-0" />
              </span>
            ),
          )}
          {filled.length > chips.length && (
            <span className="inline-flex h-5 items-center rounded-md px-1 text-[11px] font-semibold text-muted-foreground">
              +{filled.length - chips.length}
            </span>
          )}
        </div>
      )}

      {hasFooter && (
        <div className="mt-2 flex items-center gap-1.5">
          <PriorityBadge priority={card.priority} />
          {card.due_date && <DuePill due={card.due_date} today={today} completed={card.completed} />}
          <SubtaskBadge done={done} total={total} />
          {card.comment_count > 0 && (
            <span className="inline-flex h-5 items-center gap-1 text-[11px] font-semibold text-muted-foreground tabular-nums" title={`${card.comment_count} comment${card.comment_count === 1 ? "" : "s"}`}>
              <MessageSquare className="size-3.5" aria-hidden />
              {card.comment_count}
              <span className="sr-only"> comments</span>
            </span>
          )}
          {card.description && (
            <AlignLeft className="size-3.5 text-muted-foreground" aria-label="Has description" role="img" />
          )}
          {assignee && (
            <span className="ml-auto" title={`Assigned to ${assignee.full_name}`}>
              <UserAvatar id={assignee.user_id} name={assignee.full_name} size="sm" />
              <span className="sr-only">Assigned to {assignee.full_name}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

type SortableCardProps = CardViewProps & {
  columnId: string;
  onOpen: (card: BoardCard) => void;
};

/** A card in a column: draggable (pointer, touch, keyboard with Space) and opens with click or Enter. */
export function SortableCard({ columnId, onOpen, ...view }: SortableCardProps) {
  const { card, readOnly } = view;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId },
    disabled: readOnly,
  });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    listeners?.onKeyDown?.(e);
    if (e.defaultPrevented || isDragging) return;
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(card);
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative list-none", isDragging && "opacity-40")}
    >
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={`${card.title}${card.completed ? " (done)" : ""}${card.priority !== "none" ? `, ${card.priority} priority` : ""}`}
        onKeyDown={onKeyDown}
        onClick={() => onOpen(card)}
        className={cn(
          "touch-manipulation rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <CardView {...view} toggleOutside />
      </div>
      {/* Sibling of the drag handle, not nested inside it, so it stays a distinct control for assistive tech. */}
      <CompleteToggle
        card={card}
        disabled={!!readOnly || !view.onToggleComplete}
        onToggle={view.onToggleComplete}
        className={cn("absolute left-[11px]", card.cover_color ? "top-[19px]" : "top-[11px]")}
      />
    </li>
  );
}
