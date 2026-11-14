"use client";

import { Ban, Check, ChevronDown, ExternalLink, Settings2, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Member } from "@/lib/api";
import {
  OPTION_COLORS,
  coerceFieldValue,
  colorMeta,
  fieldTypeMeta,
  isEmptyValue,
  priorityMeta,
} from "@/lib/lists";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { DuePill, LabelChip } from "./board-card";
import { CardComments } from "./card-comments";
import { CardSubtasks } from "./card-subtasks";
import { DatePanel, OptionList, PickerPopover, type PickerOption } from "./picker";
import {
  FieldValueView,
  PriorityIcon,
  columnOptions,
  fieldOptions,
  labelOptions,
  memberOptions,
  priorityOptions,
} from "./pieces";
import {
  MAX_LABEL_LENGTH,
  MAX_LABELS,
  type BoardActions,
  type BoardCard,
  type BoardColumn,
  type CardPatch,
  type FieldDef,
  type FieldValue,
  type Priority,
} from "./types";
import { columnDot, useToday } from "./utils";

type Props = {
  card: BoardCard | null;
  columns: BoardColumn[];
  fields: FieldDef[];
  /** Every label used on the board (suggestions). */
  labels: string[];
  members: Member[];
  memberById: Record<string, Member>;
  meId: string | undefined;
  readOnly: boolean;
  actions: BoardActions;
  onClose: () => void;
  onManageFields?: () => void;
};

/** Card detail. Every change saves immediately (optimistic); full-screen on phones, two columns from `sm` up. */
export function CardDialog({ card, onClose, ...rest }: Props) {
  return (
    <Dialog open={!!card} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          "gap-0 overflow-hidden p-0 sm:max-w-3xl",
          "max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0",
        )}
      >
        {/* Keyed so local drafts reset whenever a different card is opened. */}
        {card && <CardEditor key={card.id} card={card} onClose={onClose} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function CardEditor({
  card,
  columns,
  fields,
  labels,
  members,
  memberById,
  meId,
  readOnly,
  actions,
  onClose,
  onManageFields,
}: Omit<Props, "card"> & { card: BoardCard }) {
  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const today = useToday();
  const ids = useId();

  // Unsaved title/description are flushed if the dialog closes mid-edit.
  const pending = useRef<{ title: string | null; description: string | null }>({ title: null, description: null });
  const latest = useRef({ card, actions });
  useEffect(() => {
    latest.current = { card, actions };
  });
  useEffect(() => {
    const p = pending.current;
    const l = latest;
    return () => {
      const patch: CardPatch = {};
      const c = l.current.card;
      if (p.title !== null && p.title.trim() && p.title.trim() !== c.title) patch.title = p.title.trim();
      if (p.description !== null && p.description.trim() !== (c.description ?? "").trim()) patch.description = p.description.trim() || null;
      p.title = p.description = null;
      if (Object.keys(patch).length) l.current.actions.updateCard(c, patch, "Couldn't save card");
    };
  }, []);

  const save = (patch: CardPatch, failure?: string) => !readOnly && actions.updateCard(card, patch, failure);

  function commitTitle() {
    if (title === null) return;
    const t = title.trim();
    if (t && t !== card.title) save({ title: t }, "Couldn't rename card");
    setTitle(null);
    pending.current.title = null;
  }

  function commitDescription() {
    if (description === null) return;
    const d = description.trim();
    if (d !== (card.description ?? "").trim()) save({ description: d || null }, "Couldn't save description");
    setDescription(null);
    pending.current.description = null;
  }

  const column = columns.find((c) => c.id === card.column_id);
  const assignee = card.assignee_id ? memberById[card.assignee_id] : undefined;
  const creator = memberById[card.created_by];

  return (
    <div className="flex min-h-0 flex-col max-sm:h-full sm:max-h-[min(88dvh,52rem)]">
      {card.cover_color && <div className={cn("h-2 shrink-0", colorMeta(card.cover_color).cover)} aria-hidden />}
      <DialogHeader className="border-b px-4 pt-4 pb-3 pr-12">
        <DialogTitle className="sr-only">Card: {card.title}</DialogTitle>
        <DialogDescription className="sr-only">Card details. Changes save automatically.</DialogDescription>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", columnDot(column?.color ?? null))} aria-hidden />
          <span className="truncate font-semibold">{column?.name ?? "Unknown column"}</span>
          {card.priority !== "none" && (
            <>
              <span aria-hidden>·</span>
              <PriorityIcon priority={card.priority} className="size-3.5" />
              <span>{priorityMeta(card.priority).label}</span>
            </>
          )}
        </div>
        <div className="flex items-start gap-2.5">
          <button
            type="button"
            role="checkbox"
            aria-checked={card.completed}
            aria-label="Completed"
            disabled={readOnly}
            onClick={() => actions.toggleComplete(card)}
            className={cn(
              "mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              card.completed
                ? "border-emerald-600 bg-emerald-600 text-white"
                : "border-muted-foreground/50 text-transparent hover:border-emerald-600 hover:text-emerald-600",
            )}
          >
            <Check className="size-3.5" strokeWidth={3} aria-hidden />
          </button>
          <textarea
            value={title ?? card.title}
            readOnly={readOnly}
            maxLength={200}
            rows={1}
            aria-label="Card title"
            aria-invalid={title !== null && !title.trim()}
            onChange={(e) => {
              const v = e.target.value.replace(/\n/g, " ");
              setTitle(v);
              pending.current.title = v;
            }}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape" && title !== null) {
                e.stopPropagation();
                setTitle(null);
                pending.current.title = null;
              }
            }}
            className={cn(
              "field-sizing-content min-w-0 flex-1 resize-none rounded-md bg-transparent px-1 py-0.5 text-lg leading-snug font-black outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              card.completed && "text-muted-foreground line-through",
            )}
          />
        </div>
      </DialogHeader>

      <div className="grid min-h-0 flex-1 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="grid content-start gap-6 px-4 py-4">
          <div className="grid gap-1.5">
            <label htmlFor={`${ids}-desc`} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
              Description
            </label>
            <textarea
              id={`${ids}-desc`}
              value={description ?? card.description ?? ""}
              readOnly={readOnly}
              maxLength={10000}
              placeholder={readOnly ? "No description" : "Add more detail: context, links, acceptance criteria…"}
              onChange={(e) => {
                setDescription(e.target.value);
                pending.current.description = e.target.value;
              }}
              onBlur={commitDescription}
              onKeyDown={(e) => {
                if (e.key === "Escape" && description !== null) {
                  e.stopPropagation();
                  setDescription(null);
                  pending.current.description = null;
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              className="field-sizing-content max-h-80 min-h-24 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </div>

          <CardSubtasks card={card} members={members} memberById={memberById} meId={meId} readOnly={readOnly} actions={actions} />

          <CardComments card={card} readOnly={readOnly} onCountChange={(d) => actions.bumpCommentCount(card.id, d)} />
        </div>

        <aside
          aria-label="Properties"
          className="grid content-start gap-0.5 border-b bg-muted/30 px-2 py-3 max-sm:order-first sm:border-b-0 sm:border-l dark:bg-muted/10"
        >
          <PickerProperty
            label="Status"
            readOnly={readOnly}
            display={
              <>
                <span className={cn("size-2.5 shrink-0 rounded-full", columnDot(column?.color ?? null))} aria-hidden />
                <span className="truncate">{column?.name ?? "—"}</span>
              </>
            }
            options={columnOptions(columns)}
            selected={[card.column_id]}
            onPick={(v) => v !== card.column_id && save({ column_id: v }, "Couldn't move card")}
          />
          <PickerProperty
            label="Assignee"
            readOnly={readOnly}
            empty={!assignee}
            emptyText="Unassigned"
            display={
              assignee && (
                <>
                  <UserAvatar id={assignee.user_id} name={assignee.full_name} size="sm" />
                  <span className="truncate">{assignee.full_name}</span>
                </>
              )
            }
            options={memberOptions(members, meId)}
            selected={[card.assignee_id ?? ""]}
            onPick={(v) => (v || null) !== card.assignee_id && save({ assignee_id: v || null })}
            action={
              !readOnly && meId && card.assignee_id !== meId ? (
                <button type="button" className="text-[11px] font-semibold text-link hover:underline" onClick={() => save({ assignee_id: meId })}>
                  Assign me
                </button>
              ) : null
            }
          />
          <PickerProperty
            label="Priority"
            readOnly={readOnly}
            empty={card.priority === "none"}
            emptyText="No priority"
            display={
              <>
                <PriorityIcon priority={card.priority} />
                <span className="truncate">{priorityMeta(card.priority).label}</span>
              </>
            }
            options={priorityOptions()}
            selected={[card.priority]}
            onPick={(v) => v !== card.priority && save({ priority: v as Priority })}
          />
          <DateProperty
            label="Due date"
            readOnly={readOnly}
            value={card.due_date}
            today={today}
            display={card.due_date ? <DuePill due={card.due_date} today={today} completed={card.completed} /> : null}
            onChange={(v) => v !== card.due_date && save({ due_date: v })}
          />
          <LabelsProperty card={card} labels={labels} readOnly={readOnly} onChange={(l) => save({ labels: l })} />
          <CoverProperty value={card.cover_color} readOnly={readOnly} onChange={(c) => c !== card.cover_color && save({ cover_color: c })} />

          {(fields.length > 0 || (!readOnly && onManageFields)) && <div className="mx-2 my-2 h-px bg-border" role="separator" />}
          {fields.map((f) => (
            <FieldProperty
              key={f.id}
              field={f}
              value={card.fields[f.id]}
              members={members}
              memberById={memberById}
              meId={meId}
              today={today}
              readOnly={readOnly}
              onChange={(v) => actions.setField(card, f, v)}
            />
          ))}
          {!readOnly && onManageFields && (
            <button
              type="button"
              onClick={onManageFields}
              className="mx-1 mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Settings2 className="size-3.5" aria-hidden /> {fields.length ? "Manage fields" : "Add a custom field"}
            </button>
          )}
        </aside>
      </div>

      <DialogFooter className="m-0 items-center rounded-none border-t sm:rounded-b-xl max-sm:mt-auto max-sm:flex-row max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
        {!readOnly &&
          (confirmingDelete ? (
            <div className="flex items-center gap-1.5 sm:mr-auto">
              <Button type="button" variant="destructive" onClick={() => actions.deleteCard(card)}>
                <Trash2 /> Confirm delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive sm:mr-auto" onClick={() => setConfirmingDelete(true)}>
              <Trash2 /> <span className="max-sm:sr-only">Delete</span>
            </Button>
          ))}
        {!confirmingDelete && (
          <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground md:inline">
            Created{creator ? ` by ${creator.full_name}` : ""} ·{" "}
            {new Date(card.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </span>
        )}
        <Button type="button" variant="outline" className="ml-auto sm:ml-0" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </div>
  );
}

// --- Property rows ----------------------------------------------------------

const propertyButton =
  "group flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent aria-expanded:bg-muted";

function PropertyRow({ label, icon, action, children }: { label: string; icon?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-1 sm:grid-cols-1 sm:gap-0">
      <div className="flex min-h-6 items-center justify-between gap-1 px-2">
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function PickerProperty({
  label,
  icon,
  display,
  empty = false,
  emptyText = "Empty",
  options,
  selected,
  multiple = false,
  onPick,
  onCreate,
  readOnly,
  action,
}: {
  label: string;
  icon?: ReactNode;
  display: ReactNode;
  empty?: boolean;
  emptyText?: string;
  options: PickerOption[];
  selected: string[];
  multiple?: boolean;
  onPick: (v: string) => void;
  onCreate?: (q: string) => void;
  readOnly: boolean;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PropertyRow label={label} icon={icon} action={action}>
      <PickerPopover
        open={open}
        onOpenChange={setOpen}
        label={label}
        trigger={<button type="button" disabled={readOnly} aria-label={`${label}: ${empty ? emptyText : "change"}`} className={propertyButton} />}
        triggerContent={
          <>
            {empty ? <span className="text-muted-foreground">{emptyText}</span> : display}
            {!readOnly && <ChevronDown className="ml-auto size-3.5 shrink-0 opacity-0 group-hover:opacity-60" aria-hidden />}
          </>
        }
      >
        <OptionList
          label={label}
          options={options}
          selected={selected}
          multiple={multiple}
          onCreate={onCreate}
          onPick={(v) => {
            onPick(v);
            if (!multiple) setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </PickerPopover>
    </PropertyRow>
  );
}

function DateProperty({
  label,
  icon,
  value,
  display,
  today,
  readOnly,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string | null;
  display: ReactNode;
  today: string;
  readOnly: boolean;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PropertyRow label={label} icon={icon}>
      <PickerPopover
        open={open}
        onOpenChange={setOpen}
        label={label}
        className="w-60"
        trigger={<button type="button" disabled={readOnly} aria-label={`${label}: ${value ?? "none"}. Change`} className={propertyButton} />}
        triggerContent={display ?? <span className="text-muted-foreground">No date</span>}
      >
        <DatePanel
          value={value ?? ""}
          today={today}
          label={label}
          onChange={(v) => {
            onChange(v);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </PickerPopover>
    </PropertyRow>
  );
}

function LabelsProperty({ card, labels, readOnly, onChange }: { card: BoardCard; labels: string[]; readOnly: boolean; onChange: (l: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const all = [...labels, ...card.labels.filter((l) => !labels.some((x) => x.toLowerCase() === l.toLowerCase()))];
  const selected = all.filter((l) => card.labels.some((x) => x.toLowerCase() === l.toLowerCase()));

  function toggle(label: string) {
    const has = card.labels.some((x) => x.toLowerCase() === label.toLowerCase());
    if (has) return onChange(card.labels.filter((x) => x.toLowerCase() !== label.toLowerCase()));
    if (card.labels.length >= MAX_LABELS) return toast.info(`A card can have up to ${MAX_LABELS} labels.`);
    onChange([...card.labels, label.slice(0, MAX_LABEL_LENGTH)]);
  }

  return (
    <PropertyRow label="Labels">
      <PickerPopover
        open={open}
        onOpenChange={setOpen}
        label="Labels"
        trigger={<button type="button" disabled={readOnly} aria-label={`Labels: ${card.labels.join(", ") || "none"}. Change`} className={cn(propertyButton, "flex-wrap")} />}
        triggerContent={
          card.labels.length ? (
            card.labels.map((l) => <LabelChip key={l} label={l} />)
          ) : (
            <span className="text-muted-foreground">No labels</span>
          )
        }
      >
        <OptionList
          label="Labels"
          multiple
          options={labelOptions(all)}
          selected={selected}
          placeholder="Search or create a label…"
          emptyText="Type to create a label"
          createLabel={(q) => `Create label “${q.slice(0, MAX_LABEL_LENGTH)}”`}
          onCreate={toggle}
          onPick={toggle}
          onClose={() => setOpen(false)}
        />
      </PickerPopover>
    </PropertyRow>
  );
}

function CoverProperty({ value, readOnly, onChange }: { value: string | null; readOnly: boolean; onChange: (c: string | null) => void }) {
  return (
    <PropertyRow label="Cover">
      <div role="group" aria-label="Cover colour" className="flex flex-wrap gap-1 px-2 py-1">
        <button
          type="button"
          aria-pressed={!value}
          aria-label="No cover"
          title="No cover"
          disabled={readOnly}
          onClick={() => onChange(null)}
          className={cn(
            "flex size-6 items-center justify-center rounded-md border text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            !value && "ring-2 ring-foreground/60",
          )}
        >
          <Ban className="size-3.5" aria-hidden />
        </button>
        {OPTION_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={value === c.key}
            aria-label={`${c.label} cover`}
            title={c.label}
            disabled={readOnly}
            onClick={() => onChange(c.key)}
            className={cn(
              "size-6 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none",
              c.cover,
              value === c.key && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background",
            )}
          />
        ))}
      </div>
    </PropertyRow>
  );
}

function FieldProperty({
  field,
  value,
  members,
  memberById,
  meId,
  today,
  readOnly,
  onChange,
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  members: Member[];
  memberById: Record<string, Member>;
  meId: string | undefined;
  today: string;
  readOnly: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const Icon = fieldTypeMeta(field.type).icon;
  const icon = <Icon className="size-3 shrink-0" aria-hidden />;
  const empty = isEmptyValue(value);
  const view = <FieldValueView field={field} value={value} memberById={memberById} className="min-w-0" />;

  switch (field.type) {
    case "select":
    case "multi_select": {
      const multiple = field.type === "multi_select";
      const sel = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      return (
        <PickerProperty
          label={field.name}
          icon={icon}
          readOnly={readOnly}
          empty={empty}
          display={view}
          options={fieldOptions(field)}
          selected={sel}
          multiple={multiple}
          onPick={(v) => {
            if (multiple) onChange(sel.includes(v) ? (sel.filter((x) => x !== v).length ? sel.filter((x) => x !== v) : null) : [...sel, v]);
            else onChange(sel[0] === v ? null : v);
          }}
        />
      );
    }
    case "person":
      return (
        <PickerProperty
          label={field.name}
          icon={icon}
          readOnly={readOnly}
          empty={empty}
          display={view}
          options={memberOptions(members, meId, true).map((o) => (o.value ? o : { ...o, label: "Nobody" }))}
          selected={[typeof value === "string" ? value : ""]}
          onPick={(v) => onChange(v || null)}
        />
      );
    case "date":
      return (
        <DateProperty
          label={field.name}
          icon={icon}
          value={typeof value === "string" ? value : null}
          today={today}
          readOnly={readOnly}
          display={empty ? null : view}
          onChange={(v) => onChange(v)}
        />
      );
    case "checkbox":
      return (
        <PropertyRow label={field.name} icon={icon}>
          <button
            type="button"
            role="checkbox"
            aria-checked={value === true}
            aria-label={field.name}
            disabled={readOnly}
            onClick={() => onChange(value === true ? null : true)}
            className={propertyButton}
          >
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-[5px] border",
                value === true ? "border-send bg-send text-white" : "border-muted-foreground/50",
              )}
              aria-hidden
            >
              {value === true && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span className="text-muted-foreground">{value === true ? "Yes" : "No"}</span>
          </button>
        </PropertyRow>
      );
    default:
      return (
        <PropertyRow label={field.name} icon={icon}>
          <InlineValueInput field={field} value={value} readOnly={readOnly} onChange={onChange} />
        </PropertyRow>
      );
  }
}

/** Text / number / URL editor: commits on blur or Enter, Escape reverts, invalid input is flagged and not saved. */
function InlineValueInput({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  readOnly: boolean;
  onChange: (v: FieldValue) => void;
}) {
  const initial = value === null || value === undefined ? "" : field.type === "number" && typeof value === "number" ? String(value) : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && coerceFieldValue(field, draft) === undefined;

  function commit() {
    if (draft === null) return;
    const v = coerceFieldValue(field, draft);
    setDraft(null);
    if (v === undefined) {
      toast.error(field.type === "url" ? "Enter a valid http(s) link." : "Enter a valid number.");
      return;
    }
    if ((v ?? "") !== (value ?? "")) onChange(v);
  }

  if (readOnly) {
    return (
      <div className="flex min-h-8 min-w-0 items-center px-2 text-[13px]">
        {isEmptyValue(value) ? <span className="text-muted-foreground">Empty</span> : <FieldValueView field={field} value={value} memberById={{}} className="min-w-0" />}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        type={field.type === "number" ? "text" : field.type === "url" ? "url" : "text"}
        inputMode={field.type === "number" ? "decimal" : field.type === "url" ? "url" : undefined}
        value={draft ?? initial}
        placeholder={field.type === "url" ? "https://…" : "Empty"}
        aria-label={field.name}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape" && draft !== null) {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className={cn(
          "h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground hover:bg-muted focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive",
          field.type === "number" && "tabular-nums",
        )}
      />
      {field.type === "url" && typeof value === "string" && value && draft === null && (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer nofollow"
          aria-label={`Open ${field.name} link`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-link hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
    </div>
  );
}
