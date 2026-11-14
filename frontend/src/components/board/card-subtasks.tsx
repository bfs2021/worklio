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
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, ListChecks, Plus, UserRound, X } from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import type { Member } from "@/lib/api";
import { cn } from "@/lib/utils";

import { OptionList, PickerPopover } from "./picker";
import { memberOptions } from "./pieces";
import { MAX_SUBTASKS, type BoardActions, type BoardCard, type Subtask } from "./types";

const isTemp = (id: string) => id.startsWith("tmp-");

/** Subtask checklist: add, check, rename, assign, drag/keyboard reorder, delete; with a progress bar. */
export function CardSubtasks({
  card,
  members,
  memberById,
  meId,
  readOnly,
  actions,
}: {
  card: BoardCard;
  members: Member[];
  memberById: Record<string, Member>;
  meId: string | undefined;
  readOnly: boolean;
  actions: BoardActions;
}) {
  const [text, setText] = useState("");
  const subtasks = card.subtasks;
  const done = subtasks.filter((s) => s.done).length;
  const total = subtasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const full = total >= MAX_SUBTASKS;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function add() {
    const t = text.trim().slice(0, 200);
    if (!t || full) return;
    actions.addSubtask(card, t);
    setText("");
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const to = subtasks.findIndex((s) => s.id === over.id);
    if (to >= 0) actions.moveSubtask(card, String(active.id), to);
  }

  const titleOf = (id: string | number) => subtasks.find((s) => s.id === id)?.title ?? "subtask";

  return (
    <section aria-labelledby={`subtasks-${card.id}`} className="grid gap-2">
      <div className="flex items-center gap-2">
        <h3 id={`subtasks-${card.id}`} className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
          <ListChecks className="size-3.5" aria-hidden /> Subtasks
        </h3>
        {total > 0 && (
          <span className="text-xs font-semibold text-muted-foreground tabular-nums">
            {done}/{total}
          </span>
        )}
      </div>
      {total > 0 && (
        <div
          role="progressbar"
          aria-label="Subtasks completed"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${done} of ${total} done`}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", pct === 100 ? "bg-emerald-500" : "bg-send")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {total > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements: {
              onDragStart: ({ active }) => `Picked up subtask ${titleOf(active.id)}.`,
              onDragOver: ({ active, over }) => (over ? `Subtask ${titleOf(active.id)} is over ${titleOf(over.id)}.` : ""),
              onDragEnd: ({ active }) => `Subtask ${titleOf(active.id)} dropped.`,
              onDragCancel: ({ active }) => `Moving subtask ${titleOf(active.id)} cancelled.`,
            },
            screenReaderInstructions: {
              draggable: "Press Space to pick up the subtask, use the arrow keys to move it, then Space to drop it or Escape to cancel.",
            },
          }}
        >
          <SortableContext items={subtasks.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="grid gap-0.5" aria-label="Subtasks">
              {subtasks.map((s) => (
                <SubtaskRow
                  key={s.id}
                  subtask={s}
                  assignee={s.assignee_id ? memberById[s.assignee_id] : undefined}
                  members={members}
                  meId={meId}
                  readOnly={readOnly}
                  onToggle={() => actions.updateSubtask(card, s, { done: !s.done })}
                  onRename={(title) => actions.updateSubtask(card, s, { title })}
                  onAssign={(id) => actions.updateSubtask(card, s, { assignee_id: id })}
                  onDelete={() => actions.deleteSubtask(card, s)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {!readOnly &&
        (full ? (
          <p className="text-xs text-muted-foreground">Limit of {MAX_SUBTASKS} subtasks reached.</p>
        ) : (
          <div className="flex items-center gap-2 rounded-lg px-1.5 focus-within:bg-muted/60">
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={text}
              maxLength={200}
              placeholder={total ? "Add another subtask" : "Break this card into subtasks…"}
              aria-label="New subtask"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  add();
                } else if (e.key === "Escape" && text) {
                  e.stopPropagation();
                  setText("");
                }
              }}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {text.trim() && (
              <button type="button" onClick={add} className="rounded-md px-2 py-1 text-xs font-semibold text-link hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                Add
              </button>
            )}
          </div>
        ))}
      {readOnly && total === 0 && <p className="text-sm text-muted-foreground">No subtasks.</p>}
    </section>
  );
}

function SubtaskRow({
  subtask,
  assignee,
  members,
  meId,
  readOnly,
  onToggle,
  onRename,
  onAssign,
  onDelete,
}: {
  subtask: Subtask;
  assignee: Member | undefined;
  members: Member[];
  meId: string | undefined;
  readOnly: boolean;
  onToggle: () => void;
  onRename: (title: string) => void;
  onAssign: (id: string | null) => void;
  onDelete: () => void;
}) {
  const temp = isTemp(subtask.id);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
    disabled: readOnly || temp,
  });
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/sub relative flex items-center gap-1.5 rounded-lg bg-background px-1 py-0.5 hover:bg-muted/60",
        isDragging && "z-10 shadow-md ring-1 ring-border",
        temp && "opacity-60",
      )}
    >
      {!readOnly && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder subtask ${subtask.title}`}
          className="flex h-6 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 opacity-60 group-hover/sub:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:opacity-0"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={subtask.done}
        aria-label={subtask.title}
        disabled={readOnly || temp}
        onClick={onToggle}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          subtask.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/50 text-transparent hover:border-emerald-600",
        )}
      >
        <Check className="size-3" strokeWidth={3} aria-hidden />
      </button>
      <input
        key={subtask.title}
        defaultValue={subtask.title}
        readOnly={readOnly || temp}
        maxLength={200}
        aria-label="Subtask title"
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (!v) e.currentTarget.value = subtask.title;
          else if (v !== subtask.title) onRename(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.value = subtask.title;
            e.currentTarget.blur();
          }
        }}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          subtask.done && "text-muted-foreground line-through",
        )}
      />
      <PickerPopover
        open={assignOpen}
        onOpenChange={setAssignOpen}
        align="end"
        label="Assign subtask"
        trigger={
          <button
            type="button"
            disabled={readOnly || temp}
            aria-label={assignee ? `Assigned to ${assignee.full_name}. Change assignee` : "Assign subtask"}
            title={assignee ? assignee.full_name : "Assign"}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default",
              !assignee && "text-muted-foreground opacity-60 group-hover/sub:opacity-100 focus-visible:opacity-100 sm:opacity-0",
            )}
          />
        }
        triggerContent={assignee ? <UserAvatar id={assignee.user_id} name={assignee.full_name} size="sm" /> : <UserRound className="size-3.5" aria-hidden />}
      >
        <OptionList
          label="Assign subtask"
          options={memberOptions(members, meId)}
          selected={[subtask.assignee_id ?? ""]}
          onPick={(v) => {
            setAssignOpen(false);
            if ((v || null) !== subtask.assignee_id) onAssign(v || null);
          }}
          onClose={() => setAssignOpen(false)}
        />
      </PickerPopover>
      {!readOnly && (
        <button
          type="button"
          disabled={temp}
          aria-label={`Delete subtask ${subtask.title}`}
          onClick={onDelete}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 group-hover/sub:opacity-100 hover:bg-muted hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:opacity-0"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}
