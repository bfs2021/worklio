"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  Maximize2,
  MessageSquare,
  Plus,
  Rows3,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Member } from "@/lib/api";
import {
  GROUP_OPTIONS,
  coerceFieldValue,
  fieldTypeMeta,
  groupCards,
  isEmptyValue,
  priorityMeta,
  sortCards,
  subtaskProgress,
  writeListPrefs,
  type GroupBy,
  type ListGroup,
  type ListPrefs,
  type SortKey,
  type SortState,
} from "@/lib/lists";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { DuePill, LabelChip } from "./board-card";
import { DatePanel, OptionList, PickerPopover } from "./picker";
import {
  FieldValueView,
  PriorityIcon,
  SubtaskBadge,
  columnOptions,
  fieldOptions,
  labelOptions,
  memberOptions,
  priorityOptions,
} from "./pieces";
import { MAX_LABEL_LENGTH, MAX_LABELS, type Board, type BoardActions, type BoardCard, type FieldDef, type NewCardExtra, type Priority } from "./types";
import { columnDot, labelColor } from "./utils";

// --- Columns ----------------------------------------------------------------

type ColKind = "title" | "status" | "assignee" | "priority" | "due" | "labels" | "subtasks" | "field";
type Col = { key: string; label: string; width: number; kind: ColKind; sortKey: SortKey; field?: FieldDef };

const FIELD_WIDTH: Record<FieldDef["type"], number> = {
  text: 190,
  number: 110,
  select: 160,
  multi_select: 210,
  person: 180,
  date: 140,
  checkbox: 100,
  url: 180,
};

function buildColumns(fields: FieldDef[]): Col[] {
  return [
    { key: "title", label: "Title", width: 280, kind: "title", sortKey: "title" },
    { key: "status", label: "Status", width: 150, kind: "status", sortKey: "status" },
    { key: "assignee", label: "Assignee", width: 180, kind: "assignee", sortKey: "assignee" },
    { key: "priority", label: "Priority", width: 130, kind: "priority", sortKey: "priority" },
    { key: "due", label: "Due", width: 130, kind: "due", sortKey: "due" },
    { key: "labels", label: "Labels", width: 200, kind: "labels", sortKey: "labels" },
    { key: "subtasks", label: "Subtasks", width: 120, kind: "subtasks", sortKey: "subtasks" },
    ...fields.map(
      (f): Col => ({ key: `field:${f.id}`, label: f.name, width: FIELD_WIDTH[f.type] ?? 160, kind: "field", sortKey: `field:${f.id}`, field: f }),
    ),
  ];
}

const isInlineCol = (c: Col) => c.kind === "title" || (c.kind === "field" && ["text", "number", "url"].includes(c.field!.type));
const isPickerCol = (c: Col) =>
  ["status", "assignee", "priority", "due", "labels"].includes(c.kind) ||
  (c.kind === "field" && ["select", "multi_select", "person", "date"].includes(c.field!.type));

// --- Rows -------------------------------------------------------------------

type Row =
  | { kind: "group"; id: string; group: ListGroup; collapsed: boolean }
  | { kind: "card"; id: string; card: BoardCard; group: ListGroup }
  | { kind: "add"; id: string; group: ListGroup };

type Cell = { row: string; col: number };

const cellKey = (rowId: string, col: number) => `${rowId}::${col}`;

type Props = {
  channelId: string;
  board: Board;
  /** Cards that pass the current filters. */
  cards: BoardCard[];
  prefs: ListPrefs;
  members: Member[];
  memberById: Record<string, Member>;
  meId: string | undefined;
  today: string;
  readOnly: boolean;
  labels: string[];
  filtered: boolean;
  actions: BoardActions;
  onClearFilters: () => void;
  onManageFields: () => void;
};

/** Spreadsheet-like table: sortable headers, grouping, inline editing and full keyboard navigation. */
export function TableView({
  channelId,
  board,
  cards,
  prefs,
  members,
  memberById,
  meId,
  today,
  readOnly,
  labels,
  filtered,
  actions,
  onClearFilters,
  onManageFields,
}: Props) {
  const [active, setActive] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<Cell | null>(null);
  const [draft, setDraft] = useState("");
  const gridRef = useRef<HTMLTableElement>(null);
  const wantFocus = useRef(false);
  const settled = useRef(false);

  const ctx = { columns: board.columns, fields: board.fields, memberById };
  const cols = buildColumns(board.fields);
  const grouped = prefs.group !== "none";
  const collapsed = new Set(prefs.collapsed);
  const groups = groupCards(sortCards(cards, prefs.sort, ctx), prefs.group, ctx, columnDot);

  const rows: Row[] = [];
  for (const g of groups) {
    const isCollapsed = grouped && collapsed.has(g.key);
    if (grouped) rows.push({ kind: "group", id: `g|${g.key}`, group: g, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (const c of g.cards) rows.push({ kind: "card", id: `c|${g.key}|${c.id}`, card: c, group: g });
    if (!readOnly && board.columns.length > 0) rows.push({ kind: "add", id: `a|${g.key}`, group: g });
  }
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));

  // The active cell, falling back to the first cell when its row disappeared.
  const activeRowIdx = active && rowIndex.has(active.row) ? rowIndex.get(active.row)! : rows.length ? 0 : -1;
  const activeCol = Math.min(active?.col ?? 0, cols.length - 1);
  const activeRow = activeRowIdx >= 0 ? rows[activeRowIdx] : undefined;
  const focusKey = activeRow ? cellKey(activeRow.id, activeRow.kind === "card" ? activeCol : 0) : "";

  const editRow = editing ? rows[rowIndex.get(editing.row) ?? -1] : undefined;
  const editCol = editing ? cols[editing.col] : undefined;
  const editCard = editRow?.kind === "card" ? editRow.card : undefined;
  const pickerOpen = !!editCard && !!editCol && isPickerCol(editCol);

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(focusKey)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  const setPrefs = (patch: Partial<ListPrefs>) => writeListPrefs(channelId, patch);

  function focusCell(row: string, col: number) {
    setActive({ row, col });
    wantFocus.current = true;
  }

  function move(dr: number, dc: number, absolute?: { row?: number; col?: number }) {
    if (!rows.length) return;
    const r = Math.max(0, Math.min(rows.length - 1, absolute?.row ?? activeRowIdx + dr));
    const c = Math.max(0, Math.min(cols.length - 1, absolute?.col ?? activeCol + dc));
    focusCell(rows[r].id, c);
  }

  function endEdit(refocus = true) {
    setEditing(null);
    setDraft("");
    if (refocus) wantFocus.current = true;
  }

  function toggleGroup(key: string) {
    const next = collapsed.has(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key];
    setPrefs({ collapsed: next });
  }

  function addExtra(g: ListGroup): { columnId: string; extra: NewCardExtra } {
    const extra: NewCardExtra = {};
    if (g.assigneeId) extra.assignee_id = g.assigneeId;
    if (g.priority && g.priority !== "none") extra.priority = g.priority;
    if (g.labelName) extra.labels = [g.labelName];
    return { columnId: g.columnId ?? board.columns[0]?.id ?? "", extra };
  }

  function currentText(card: BoardCard, col: Col): string {
    if (col.kind === "title") return card.title;
    const v = col.field ? card.fields[col.field.id] : null;
    return v === null || v === undefined ? "" : String(v);
  }

  /** Enter / F2 / click: edit the cell, toggle it, or open the card. */
  function activate(row: Row, colIdx: number, typed?: string) {
    if (row.kind === "group") return toggleGroup(row.group.key);
    if (row.kind === "add") {
      settled.current = false;
      setEditing({ row: row.id, col: 0 });
      setDraft(typed ?? "");
      return;
    }
    const col = cols[colIdx];
    const card = row.card;
    if (readOnly || col.kind === "subtasks" || card.id.startsWith("tmp-")) return actions.openCard(card.id);
    if (col.kind === "field" && col.field!.type === "checkbox") {
      actions.setField(card, col.field!, card.fields[col.field!.id] === true ? null : true);
      return;
    }
    settled.current = false;
    setActive({ row: row.id, col: colIdx });
    setEditing({ row: row.id, col: colIdx });
    setDraft(isInlineCol(col) ? (typed ?? currentText(card, col)) : "");
  }

  function clearCell(card: BoardCard, col: Col) {
    if (readOnly) return;
    switch (col.kind) {
      case "assignee":
        if (card.assignee_id) actions.updateCard(card, { assignee_id: null });
        break;
      case "priority":
        if (card.priority !== "none") actions.updateCard(card, { priority: "none" });
        break;
      case "due":
        if (card.due_date) actions.updateCard(card, { due_date: null });
        break;
      case "labels":
        if (card.labels.length) actions.updateCard(card, { labels: [] });
        break;
      case "field":
        if (!isEmptyValue(card.fields[col.field!.id])) actions.setField(card, col.field!, null);
        break;
    }
  }

  /** "enter" keeps the add-row open for rapid entry; "blur" doesn't steal focus back; "close" refocuses the cell. */
  function commitInline(mode: "enter" | "blur" | "close") {
    if (!editRow || settled.current) return;
    const refocus = mode !== "blur";
    if (editRow.kind === "add") {
      const t = draft.trim().slice(0, 200);
      if (t) {
        const { columnId, extra } = addExtra(editRow.group);
        if (columnId) actions.addCard(columnId, t, extra);
        setDraft("");
        if (mode === "enter") return;
      }
      settled.current = true;
      return endEdit(refocus);
    }
    if (editRow.kind !== "card" || !editCol) return;
    const card = editRow.card;
    settled.current = true;
    if (editCol.kind === "title") {
      const t = draft.trim().slice(0, 200);
      if (t && t !== card.title) actions.updateCard(card, { title: t }, "Couldn't rename card");
    } else if (editCol.field) {
      const v = coerceFieldValue(editCol.field, draft);
      if (v === undefined) toast.error(editCol.field.type === "url" ? "Enter a valid http(s) link." : "Enter a valid number.");
      else if ((v ?? "") !== (card.fields[editCol.field.id] ?? "")) actions.setField(card, editCol.field, v);
    }
    endEdit(refocus);
  }

  function onGridKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    const target = e.target as HTMLElement;
    if (!target.dataset.cell || editing) return;
    const row = activeRow;
    if (!row) return;
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return mod ? move(0, 0, { row: rows.length - 1 }) : move(1, 0);
      case "ArrowUp":
        e.preventDefault();
        return mod ? move(0, 0, { row: 0 }) : move(-1, 0);
      case "ArrowRight":
        e.preventDefault();
        return move(0, 1);
      case "ArrowLeft":
        e.preventDefault();
        return move(0, -1);
      case "Home":
        e.preventDefault();
        return mod ? move(0, 0, { row: 0, col: 0 }) : move(0, 0, { col: 0 });
      case "End":
        e.preventDefault();
        return mod ? move(0, 0, { row: rows.length - 1, col: cols.length - 1 }) : move(0, 0, { col: cols.length - 1 });
      case "PageDown":
        e.preventDefault();
        return move(10, 0);
      case "PageUp":
        e.preventDefault();
        return move(-10, 0);
      case "Enter":
      case "F2":
        e.preventDefault();
        return activate(row, activeCol);
      case " ":
        e.preventDefault();
        if (row.kind !== "card") return activate(row, activeCol);
        if (cols[activeCol].kind === "field" && cols[activeCol].field!.type === "checkbox") return activate(row, activeCol);
        return actions.openCard(row.card.id);
      case "Delete":
      case "Backspace":
        if (row.kind === "card") {
          e.preventDefault();
          clearCell(row.card, cols[activeCol]);
        }
        return;
      default:
        if (row.kind === "card" && !readOnly && !mod && !e.altKey) {
          if (e.key === "x" && cols[activeCol].kind !== "title" && !isInlineCol(cols[activeCol])) {
            e.preventDefault();
            return actions.toggleComplete(row.card);
          }
          // Type-to-edit on text-like cells, like a spreadsheet.
          if (e.key.length === 1 && isInlineCol(cols[activeCol])) {
            e.preventDefault();
            return activate(row, activeCol, e.key);
          }
        }
    }
  }

  function toggleSort(key: SortKey) {
    const s = prefs.sort;
    const next: SortState = !s || s.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null;
    setPrefs({ sort: next });
  }

  const totalWidth = cols.reduce((n, c) => n + c.width, 0) + 40;
  const sortCol = prefs.sort ? cols.find((c) => c.sortKey === prefs.sort!.key) : undefined;
  const groupKeys = groups.map((g) => g.key);
  const allCollapsed = grouped && groupKeys.length > 0 && groupKeys.every((k) => collapsed.has(k));

  // --- Rendering helpers ---------------------------------------------------

  function cellProps(rowId: string, colIdx: number, label: string, isCardRow = true) {
    const key = cellKey(rowId, colIdx);
    return {
      "data-cell": key,
      role: "gridcell" as const,
      tabIndex: key === focusKey ? 0 : -1,
      "aria-label": label,
      onFocus: () => {
        if (isCardRow) {
          if (active?.row !== rowId || active.col !== colIdx) setActive({ row: rowId, col: colIdx });
        } else if (active?.row !== rowId) {
          setActive({ row: rowId, col: active?.col ?? 0 });
        }
      },
    };
  }

  function renderCardCell(row: Extract<Row, { kind: "card" }>, col: Col, colIdx: number) {
    const card = row.card;
    const isEditing = editing?.row === row.id && editing.col === colIdx;
    const sticky = col.kind === "title";
    const base = cn(
      "h-9 border-b border-r px-2 align-middle text-[13px] outline-none focus-visible:z-[5] focus-visible:shadow-[inset_0_0_0_2px_var(--color-send)]",
      "bg-background group-hover/row:bg-[color-mix(in_oklch,var(--muted)_55%,var(--background))]",
      sticky ? "sticky left-0 z-[4] shadow-[1px_0_0_var(--border)]" : "scroll-ml-[280px] scroll-mt-9",
      isEditing && "shadow-[inset_0_0_0_2px_var(--color-send)]",
    );

    if (isEditing && isInlineCol(col)) {
      return (
        <td key={col.key} className={cn(base, "p-0")} data-cell={cellKey(row.id, colIdx)} role="gridcell" tabIndex={-1}>
          <input
            autoFocus
            value={draft}
            aria-label={`Edit ${col.label}`}
            maxLength={col.kind === "title" ? 200 : 2000}
            inputMode={col.field?.type === "number" ? "decimal" : col.field?.type === "url" ? "url" : undefined}
            onFocus={(e) => {
              const len = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(len, len);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitInline("blur")}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitInline("close");
              } else if (e.key === "Escape") {
                e.preventDefault();
                settled.current = true;
                endEdit(true);
              } else if (e.key === "Tab") {
                e.preventDefault();
                commitInline("close");
                move(0, e.shiftKey ? -1 : 1);
              }
            }}
            className={cn("h-9 w-full bg-background px-2 text-[13px] outline-none", col.field?.type === "number" && "text-right tabular-nums")}
          />
        </td>
      );
    }

    let content: ReactNode;
    let label: string = col.label;
    switch (col.kind) {
      case "title": {
        label = `${card.title}${card.completed ? ", done" : ""}`;
        content = (
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              role="checkbox"
              tabIndex={-1}
              aria-checked={card.completed}
              aria-label={card.completed ? "Mark as not done" : "Mark as done"}
              disabled={readOnly}
              onClick={(e) => {
                e.stopPropagation();
                actions.toggleComplete(card);
              }}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                card.completed ? "border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/50 text-transparent hover:border-emerald-600 hover:text-emerald-600",
              )}
            >
              <Check className="size-3" strokeWidth={3} aria-hidden />
            </button>
            <span className={cn("min-w-0 flex-1 truncate font-medium", card.completed && "text-muted-foreground line-through")} title={card.title}>
              {card.title}
            </span>
            {card.comment_count > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums" title={`${card.comment_count} comments`}>
                <MessageSquare className="size-3" aria-hidden />
                {card.comment_count}
              </span>
            )}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Open ${card.title}`}
              onClick={(e) => {
                e.stopPropagation();
                actions.openCard(card.id);
              }}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md border bg-background px-1.5 text-[11px] font-semibold text-muted-foreground opacity-0 shadow-xs group-hover/row:opacity-100 hover:text-foreground max-sm:opacity-100"
            >
              <Maximize2 className="size-3" aria-hidden /> <span className="max-md:sr-only">Open</span>
            </button>
          </div>
        );
        break;
      }
      case "status": {
        const c = board.columns.find((x) => x.id === card.column_id);
        label = `Status: ${c?.name ?? "unknown"}`;
        content = (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("size-2.5 shrink-0 rounded-full", columnDot(c?.color ?? null))} aria-hidden />
            <span className="truncate">{c?.name ?? "—"}</span>
          </span>
        );
        break;
      }
      case "assignee": {
        const m = card.assignee_id ? memberById[card.assignee_id] : undefined;
        label = `Assignee: ${m?.full_name ?? "unassigned"}`;
        content = m ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <UserAvatar id={m.user_id} name={m.full_name} size="sm" />
            <span className="truncate">{m.full_name}</span>
          </span>
        ) : (
          <Empty />
        );
        break;
      }
      case "priority":
        label = `Priority: ${priorityMeta(card.priority).label}`;
        content =
          card.priority === "none" ? (
            <Empty />
          ) : (
            <span className="flex items-center gap-1.5">
              <PriorityIcon priority={card.priority} />
              {priorityMeta(card.priority).label}
            </span>
          );
        break;
      case "due":
        label = `Due: ${card.due_date ?? "none"}`;
        content = card.due_date ? <DuePill due={card.due_date} today={today} completed={card.completed} /> : <Empty />;
        break;
      case "labels":
        label = `Labels: ${card.labels.join(", ") || "none"}`;
        content = card.labels.length ? (
          <span className="flex min-w-0 gap-1 overflow-hidden">
            {card.labels.map((l) => (
              <LabelChip key={l} label={l} className="shrink-0" />
            ))}
          </span>
        ) : (
          <Empty />
        );
        break;
      case "subtasks": {
        const { done, total } = subtaskProgress(card);
        label = total ? `Subtasks: ${done} of ${total} done` : "No subtasks";
        content = total ? <SubtaskBadge done={done} total={total} /> : <Empty />;
        break;
      }
      case "field": {
        const f = col.field!;
        const v = card.fields[f.id];
        label = `${f.name}: ${isEmptyValue(v) ? "empty" : Array.isArray(v) ? `${v.length} selected` : String(v)}`;
        if (f.type === "checkbox") {
          content = (
            <span
              className={cn(
                "mx-auto flex size-4 items-center justify-center rounded-[5px] border",
                v === true ? "border-send bg-send text-white" : "border-muted-foreground/40",
              )}
              aria-hidden
            >
              {v === true && <Check className="size-3" strokeWidth={3} />}
            </span>
          );
        } else {
          content = isEmptyValue(v) ? (
            <Empty />
          ) : (
            <FieldValueView field={f} value={v} memberById={memberById} compact className={cn("min-w-0", f.type === "number" && "block text-right")} />
          );
        }
        break;
      }
    }

    return (
      <td
        key={col.key}
        {...cellProps(row.id, colIdx, label)}
        aria-readonly={readOnly || undefined}
        className={cn(base, "cursor-default overflow-hidden")}
        onClick={() => {
          setActive({ row: row.id, col: colIdx });
          if (col.kind !== "title") activate(row, colIdx);
        }}
        onDoubleClick={() => col.kind === "title" && activate(row, colIdx)}
      >
        {content}
      </td>
    );
  }

  // --- Picker popover for the editing cell -----------------------------------

  let picker: ReactNode = null;
  if (pickerOpen && editCard && editCol) {
    const card = editCard;
    const close = () => endEdit(true);
    switch (editCol.kind) {
      case "status":
        picker = (
          <OptionList
            label="Status"
            options={columnOptions(board.columns)}
            selected={[card.column_id]}
            onPick={(v) => {
              if (v !== card.column_id) actions.updateCard(card, { column_id: v }, "Couldn't move card");
              close();
            }}
            onClose={close}
          />
        );
        break;
      case "assignee":
        picker = (
          <OptionList
            label="Assignee"
            options={memberOptions(members, meId)}
            selected={[card.assignee_id ?? ""]}
            onPick={(v) => {
              if ((v || null) !== card.assignee_id) actions.updateCard(card, { assignee_id: v || null });
              close();
            }}
            onClose={close}
          />
        );
        break;
      case "priority":
        picker = (
          <OptionList
            label="Priority"
            options={priorityOptions()}
            selected={[card.priority]}
            onPick={(v) => {
              if (v !== card.priority) actions.updateCard(card, { priority: v as Priority });
              close();
            }}
            onClose={close}
          />
        );
        break;
      case "due":
        picker = (
          <DatePanel
            value={card.due_date ?? ""}
            today={today}
            label="Due date"
            onChange={(v) => {
              if (v !== card.due_date) actions.updateCard(card, { due_date: v });
              close();
            }}
            onClose={close}
          />
        );
        break;
      case "labels": {
        const all = [...labels, ...card.labels.filter((l) => !labels.some((x) => x.toLowerCase() === l.toLowerCase()))];
        const toggle = (label: string) => {
          const has = card.labels.some((x) => x.toLowerCase() === label.toLowerCase());
          if (has) return actions.updateCard(card, { labels: card.labels.filter((x) => x.toLowerCase() !== label.toLowerCase()) });
          if (card.labels.length >= MAX_LABELS) return toast.info(`A card can have up to ${MAX_LABELS} labels.`);
          actions.updateCard(card, { labels: [...card.labels, label.slice(0, MAX_LABEL_LENGTH)] });
        };
        picker = (
          <OptionList
            label="Labels"
            multiple
            options={labelOptions(all)}
            selected={all.filter((l) => card.labels.some((x) => x.toLowerCase() === l.toLowerCase()))}
            placeholder="Search or create a label…"
            emptyText="Type to create a label"
            onCreate={toggle}
            onPick={toggle}
            onClose={close}
          />
        );
        break;
      }
      case "field": {
        const f = editCol.field!;
        const v = card.fields[f.id];
        if (f.type === "date") {
          picker = (
            <DatePanel
              value={typeof v === "string" ? v : ""}
              today={today}
              label={f.name}
              onChange={(next) => {
                if (next !== (v ?? null)) actions.setField(card, f, next);
                close();
              }}
              onClose={close}
            />
          );
        } else if (f.type === "person") {
          picker = (
            <OptionList
              label={f.name}
              options={memberOptions(members, meId).map((o) => (o.value ? o : { ...o, label: "Nobody" }))}
              selected={[typeof v === "string" ? v : ""]}
              onPick={(next) => {
                if ((next || null) !== (v ?? null)) actions.setField(card, f, next || null);
                close();
              }}
              onClose={close}
            />
          );
        } else {
          const multiple = f.type === "multi_select";
          const sel = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
          picker = (
            <OptionList
              label={f.name}
              options={fieldOptions(f)}
              selected={sel}
              multiple={multiple}
              emptyText={f.options.length ? "No matches" : "No options yet — add some in Fields"}
              onPick={(id) => {
                if (multiple) {
                  const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
                  actions.setField(card, f, next.length ? next : null);
                } else {
                  actions.setField(card, f, sel[0] === id ? null : id);
                  close();
                }
              }}
              onClose={close}
            />
          );
        }
        break;
      }
    }
  }

  // --- Render -------------------------------------------------------------------

  const visibleCount = cards.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 sm:px-5">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
            <Rows3 /> Group: <span className="font-semibold">{GROUP_OPTIONS.find((g) => g.key === prefs.group)?.label}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={prefs.group} onValueChange={(v) => setPrefs({ group: v as GroupBy, collapsed: [] })}>
                {GROUP_OPTIONS.map((g) => (
                  <DropdownMenuRadioItem key={g.key} value={g.key}>
                    {g.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            {grouped && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setPrefs({ collapsed: allCollapsed ? [] : groupKeys })}>
                  {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} {allCollapsed ? "Expand all" : "Collapse all"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {sortCol && prefs.sort && (
          <span className="inline-flex h-7 items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-[0.8rem]">
            {prefs.sort.dir === "asc" ? <ArrowUp className="size-3.5" aria-hidden /> : <ArrowDown className="size-3.5" aria-hidden />}
            Sorted by <span className="font-semibold">{sortCol.label}</span>
            <Button variant="ghost" size="icon-xs" aria-label="Clear sort" onClick={() => setPrefs({ sort: null })}>
              <X />
            </Button>
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {visibleCount} card{visibleCount === 1 ? "" : "s"}
        </span>
        {!readOnly && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onManageFields}>
            <Columns3 /> <span className="max-sm:sr-only">Add column</span>
          </Button>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto overscroll-contain border-t">
        <table
          ref={gridRef}
          role="grid"
          aria-label="Cards table"
          aria-rowcount={rows.length + 1}
          aria-colcount={cols.length}
          onKeyDown={onGridKeyDown}
          className="table-fixed border-separate border-spacing-0"
          style={{ width: totalWidth, minWidth: "100%" }}
        >
          <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr role="row">
              {cols.map((c) => {
                const sorted = prefs.sort?.key === c.sortKey ? prefs.sort.dir : null;
                const Icon = c.kind === "field" ? fieldTypeMeta(c.field!.type).icon : null;
                return (
                  <th
                    key={c.key}
                    role="columnheader"
                    scope="col"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                    className={cn(
                      "sticky top-0 z-[6] h-9 border-r border-b bg-background p-0 text-left text-xs font-semibold text-muted-foreground",
                      c.kind === "title" && "left-0 z-[7] shadow-[1px_0_0_var(--border)]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sortKey)}
                      title={`Sort by ${c.label}`}
                      className="group/th flex h-9 w-full min-w-0 items-center gap-1.5 px-2 hover:bg-muted hover:text-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--color-ring)] focus-visible:outline-none"
                    >
                      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden />}
                      <span className="truncate">{c.label}</span>
                      {sorted === "asc" ? (
                        <ArrowUp className="ml-auto size-3.5 shrink-0 text-foreground" aria-hidden />
                      ) : sorted === "desc" ? (
                        <ArrowDown className="ml-auto size-3.5 shrink-0 text-foreground" aria-hidden />
                      ) : (
                        <ArrowUpDown className="ml-auto size-3.5 shrink-0 opacity-0 group-hover/th:opacity-60" aria-hidden />
                      )}
                    </button>
                  </th>
                );
              })}
              <th className="sticky top-0 z-[6] border-b bg-background p-0" aria-hidden>
                {!readOnly && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={onManageFields}
                    title="Add a field"
                    className="flex h-9 w-10 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              if (row.kind === "group") {
                const g = row.group;
                return (
                  <tr key={row.id} role="row">
                    <td
                      colSpan={cols.length + 1}
                      {...cellProps(row.id, 0, `${g.label}, ${g.cards.length} cards, ${row.collapsed ? "collapsed" : "expanded"}`, false)}
                      aria-expanded={!row.collapsed}
                      onClick={() => {
                        setActive({ row: row.id, col: activeCol });
                        toggleGroup(g.key);
                      }}
                      className="h-9 cursor-pointer border-b bg-muted/50 p-0 outline-none select-none hover:bg-muted focus-visible:shadow-[inset_0_0_0_2px_var(--color-send)] dark:bg-muted/30"
                    >
                      <div className="sticky left-0 flex w-max max-w-[100vw] items-center gap-2 px-2 text-[13px] font-semibold">
                        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !row.collapsed && "rotate-90")} aria-hidden />
                        <GroupIcon group={g} memberById={memberById} />
                        <span className="truncate">{g.label}</span>
                        <span className="rounded-full bg-background/80 px-1.5 text-[11px] text-muted-foreground tabular-nums">{g.cards.length}</span>
                      </div>
                    </td>
                  </tr>
                );
              }
              if (row.kind === "add") {
                const isEditing = editing?.row === row.id;
                return (
                  <tr key={row.id} role="row">
                    <td
                      colSpan={cols.length + 1}
                      {...(isEditing ? { "data-cell": cellKey(row.id, 0), role: "gridcell" as const, tabIndex: -1 } : cellProps(row.id, 0, `New card${grouped ? ` in ${row.group.label}` : ""}`, false))}
                      onClick={() => !isEditing && activate(row, 0)}
                      className={cn(
                        "h-9 border-b p-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-send)]",
                        !isEditing && "cursor-pointer text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      {isEditing ? (
                        <div className="sticky left-0 flex w-[min(100vw-2rem,36rem)] items-center gap-2 px-2">
                          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <input
                            autoFocus
                            value={draft}
                            maxLength={200}
                            placeholder="Card title — Enter to add, Esc to finish"
                            aria-label={`New card title${grouped ? ` in ${row.group.label}` : ""}`}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commitInline("blur")}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                if (draft.trim()) commitInline("enter");
                                else {
                                  settled.current = true;
                                  endEdit(true);
                                }
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                commitInline("close");
                              }
                            }}
                            className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
                          />
                        </div>
                      ) : (
                        <div className="sticky left-0 flex w-max items-center gap-2 px-2 text-[13px]">
                          <Plus className="size-4" aria-hidden /> New card
                        </div>
                      )}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.id} role="row" className="group/row">
                  {cols.map((c, i) => renderCardCell(row, c, i))}
                  <td className="border-b bg-background group-hover/row:bg-[color-mix(in_oklch,var(--muted)_55%,var(--background))]" aria-hidden />
                </tr>
              );
            })}
          </tbody>
        </table>

        {cards.length === 0 && (
          <div className="sticky left-0 mx-auto flex max-w-sm flex-col items-center px-6 py-10 text-center">
            {filtered ? (
              <>
                <p className="font-bold">No cards match these filters</p>
                <p className="mb-3 text-sm text-muted-foreground">Try removing a filter or searching for something else.</p>
                <Button variant="outline" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              </>
            ) : (
              <>
                <p className="font-bold">No cards yet</p>
                <p className="text-sm text-muted-foreground">
                  {readOnly ? "This list is empty." : "Add the first card with “New card” above, or switch to the board view."}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <p className="hidden border-t px-5 py-1.5 text-[11px] text-muted-foreground md:block">
        <Kbd>↑↓←→</Kbd> move · <Kbd>Enter</Kbd> edit · <Kbd>Space</Kbd> open card · <Kbd>X</Kbd> toggle done · <Kbd>Del</Kbd> clear ·{" "}
        <Kbd>Esc</Kbd> cancel
        {board.fields.length === 0 && !readOnly && (
          <>
            {" · "}
            <button type="button" onClick={onManageFields} className="inline-flex items-center gap-1 font-semibold text-link hover:underline">
              <Settings2 className="size-3" aria-hidden /> Add custom fields
            </button>
          </>
        )}
      </p>

      <PickerPopover
        open={pickerOpen}
        onOpenChange={(o) => !o && endEdit(true)}
        anchor={() => (editing ? (gridRef.current?.querySelector(`[data-cell="${CSS.escape(cellKey(editing.row, editing.col))}"]`) ?? null) : null)}
        restoreFocus={false}
        label={editCol?.label}
        className={editCol?.kind === "due" || editCol?.field?.type === "date" ? "w-60" : undefined}
      >
        {picker}
      </PickerPopover>
    </div>
  );
}

function Empty() {
  return <span className="text-muted-foreground/60">—</span>;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-sans text-[10px]">{children}</kbd>;
}

function GroupIcon({ group, memberById }: { group: ListGroup; memberById: Record<string, Member> }) {
  if (group.dot) return <span className={cn("size-2.5 shrink-0 rounded-full", group.dot)} aria-hidden />;
  if (group.priority) return <PriorityIcon priority={group.priority} />;
  if (group.assigneeId) {
    const m = memberById[group.assigneeId];
    return <UserAvatar id={group.assigneeId} name={m?.full_name ?? "?"} size="sm" />;
  }
  if (group.labelName) return <span className={cn("size-2.5 shrink-0 rounded-full", labelColor(group.labelName).split(" ")[0])} aria-hidden />;
  return null;
}
