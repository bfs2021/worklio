/**
 * Lists v2: shared logic for the channel board + table views.
 *  - API calls for fields, subtasks, comments and column reordering
 *  - priority / colour / field-type metadata
 *  - field value coercion, display text and comparison
 *  - filtering (with faceted counts), sorting and grouping
 *  - per-channel view preferences (localStorage, guarded, with an in-memory fallback)
 *  - @mention autocomplete helpers
 */
import {
  Calendar,
  CircleCheck,
  CircleDot,
  Hash,
  Link2,
  ListChecks,
  Type,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useSyncExternalStore } from "react";

import type {
  Board,
  BoardCard,
  BoardColumn,
  BoardFilters,
  CardComment,
  DueFilter,
  FieldDef,
  FieldOption,
  FieldPatch,
  FieldType,
  FieldValue,
  Priority,
  Subtask,
  SubtaskPatch,
} from "@/components/board/types";
import { addDays, byPosition } from "@/components/board/utils";
import { api, type Member } from "@/lib/api";

// --- Ids --------------------------------------------------------------------

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

// --- API --------------------------------------------------------------------

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function asList<T>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    const inner = r[key] ?? r.items;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

export const listsApi = {
  reorderColumns: (columnIds: string[]) => api<unknown>("/board/columns/reorder", json("POST", { column_ids: columnIds })),

  createField: (channelId: string, body: { name: string; type: FieldType; options?: FieldOption[] }) =>
    api<FieldDef>(`/channels/${channelId}/board/fields`, json("POST", body)),
  updateField: (fieldId: string, patch: FieldPatch) => api<FieldDef>(`/board/fields/${fieldId}`, json("PATCH", patch)),
  deleteField: (fieldId: string) => api<void>(`/board/fields/${fieldId}`, json("DELETE")),

  addSubtask: (cardId: string, body: { title: string; assignee_id?: string | null }) =>
    api<Subtask>(`/board/cards/${cardId}/subtasks`, json("POST", body)),
  updateSubtask: (subtaskId: string, patch: SubtaskPatch) => api<Subtask>(`/board/subtasks/${subtaskId}`, json("PATCH", patch)),
  deleteSubtask: (subtaskId: string) => api<void>(`/board/subtasks/${subtaskId}`, json("DELETE")),

  listComments: async (cardId: string) =>
    asList<CardComment>(await api<unknown>(`/board/cards/${cardId}/comments`), "comments"),
  addComment: (cardId: string, body: string) => api<CardComment>(`/board/cards/${cardId}/comments`, json("POST", { body })),
  updateComment: (commentId: string, body: string) => api<CardComment>(`/board/comments/${commentId}`, json("PATCH", { body })),
  deleteComment: (commentId: string) => api<void>(`/board/comments/${commentId}`, json("DELETE")),
};

// --- Priority ---------------------------------------------------------------

export type PriorityMeta = { key: Priority; label: string; rank: number; text: string; chip: string };

export const PRIORITIES: PriorityMeta[] = [
  {
    key: "urgent",
    label: "Urgent",
    rank: 0,
    text: "text-rose-600 dark:text-rose-400",
    chip: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  },
  {
    key: "high",
    label: "High",
    rank: 1,
    text: "text-orange-600 dark:text-orange-400",
    chip: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
  },
  {
    key: "medium",
    label: "Medium",
    rank: 2,
    text: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  },
  {
    key: "low",
    label: "Low",
    rank: 3,
    text: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  },
  { key: "none", label: "No priority", rank: 4, text: "text-muted-foreground", chip: "bg-muted text-muted-foreground" },
];

const PRIORITY_BY_KEY = Object.fromEntries(PRIORITIES.map((p) => [p.key, p])) as Record<Priority, PriorityMeta>;
export const priorityMeta = (p: Priority | null | undefined): PriorityMeta => PRIORITY_BY_KEY[p ?? "none"] ?? PRIORITY_BY_KEY.none;

// --- Colours ----------------------------------------------------------------

export type ColorMeta = { key: string; label: string; dot: string; pill: string; cover: string };

/** Shared palette for select options and card covers (keys match the column palette). */
export const OPTION_COLORS: ColorMeta[] = [
  { key: "slate", label: "Gray", dot: "bg-slate-400", pill: "bg-slate-100 text-slate-700 dark:bg-slate-500/25 dark:text-slate-200", cover: "bg-slate-400 dark:bg-slate-500" },
  { key: "sky", label: "Blue", dot: "bg-sky-500", pill: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200", cover: "bg-sky-400 dark:bg-sky-500" },
  { key: "violet", label: "Purple", dot: "bg-violet-500", pill: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200", cover: "bg-violet-400 dark:bg-violet-500" },
  { key: "emerald", label: "Green", dot: "bg-emerald-500", pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200", cover: "bg-emerald-400 dark:bg-emerald-500" },
  { key: "teal", label: "Teal", dot: "bg-teal-500", pill: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200", cover: "bg-teal-400 dark:bg-teal-500" },
  { key: "amber", label: "Yellow", dot: "bg-amber-500", pill: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200", cover: "bg-amber-300 dark:bg-amber-500" },
  { key: "orange", label: "Orange", dot: "bg-orange-500", pill: "bg-orange-100 text-orange-900 dark:bg-orange-500/20 dark:text-orange-200", cover: "bg-orange-400 dark:bg-orange-500" },
  { key: "rose", label: "Red", dot: "bg-rose-500", pill: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200", cover: "bg-rose-400 dark:bg-rose-500" },
  { key: "pink", label: "Pink", dot: "bg-pink-500", pill: "bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200", cover: "bg-pink-400 dark:bg-pink-500" },
];

const COLOR_BY_KEY = Object.fromEntries(OPTION_COLORS.map((c) => [c.key, c]));
export const colorMeta = (key: string | null | undefined): ColorMeta => COLOR_BY_KEY[key ?? ""] ?? OPTION_COLORS[0];

/** Next colour for a new select option: the first one not used yet, cycling. */
export function nextOptionColor(options: FieldOption[]): string {
  const used = new Set(options.map((o) => o.color));
  return (OPTION_COLORS.find((c) => !used.has(c.key)) ?? OPTION_COLORS[options.length % OPTION_COLORS.length]).key;
}

// --- Field types -------------------------------------------------------------

export const FIELD_TYPES: { type: FieldType; label: string; icon: LucideIcon; hint: string }[] = [
  { type: "text", label: "Text", icon: Type, hint: "Short free text" },
  { type: "number", label: "Number", icon: Hash, hint: "Estimates, points, amounts" },
  { type: "select", label: "Select", icon: CircleDot, hint: "One option from a list" },
  { type: "multi_select", label: "Multi-select", icon: ListChecks, hint: "Several options from a list" },
  { type: "person", label: "Person", icon: UserRound, hint: "A workspace member" },
  { type: "date", label: "Date", icon: Calendar, hint: "A calendar date" },
  { type: "checkbox", label: "Checkbox", icon: CircleCheck, hint: "Yes / no" },
  { type: "url", label: "URL", icon: Link2, hint: "A web link" },
];

export const fieldTypeMeta = (t: FieldType) => FIELD_TYPES.find((f) => f.type === t) ?? FIELD_TYPES[0];
export const hasOptions = (t: FieldType) => t === "select" || t === "multi_select";

export const MAX_FIELD_NAME = 40;
export const MAX_OPTION_LABEL = 40;
export const MAX_TEXT_VALUE = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise a URL typed by a person; returns null for anything that isn't http(s). */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Validate + normalise a value for a field. Returns `null` to clear,
 * or `undefined` when the input is invalid for that field type.
 */
export function coerceFieldValue(field: FieldDef, raw: unknown): FieldValue | undefined {
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case "text": {
      if (typeof raw !== "string") return undefined;
      const t = raw.trim().slice(0, MAX_TEXT_VALUE);
      return t || null;
    }
    case "url": {
      if (typeof raw !== "string") return undefined;
      if (!raw.trim()) return null;
      return normalizeUrl(raw) ?? undefined;
    }
    case "number": {
      if (typeof raw === "string" && !raw.trim()) return null;
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "select": {
      if (typeof raw !== "string") return undefined;
      if (!raw) return null;
      return field.options.some((o) => o.id === raw) ? raw : undefined;
    }
    case "multi_select": {
      if (!Array.isArray(raw)) return undefined;
      const ids = new Set(field.options.map((o) => o.id));
      const out = [...new Set(raw.filter((x): x is string => typeof x === "string" && ids.has(x)))];
      return out.length ? out : null;
    }
    case "person":
      return typeof raw === "string" ? raw || null : undefined;
    case "date":
      if (typeof raw !== "string") return undefined;
      if (!raw) return null;
      return DATE_RE.test(raw) ? raw : undefined;
    case "checkbox":
      return typeof raw === "boolean" ? raw : undefined;
  }
}

export function isEmptyValue(v: FieldValue | undefined): boolean {
  return v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
}

/** Options of a select/multi-select value, in the field's option order (unknown ids dropped). */
export function selectedOptions(field: FieldDef, v: FieldValue | undefined): FieldOption[] {
  const ids = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return field.options.filter((o) => ids.includes(o.id));
}

/** Plain-text rendering of a field value (search, sort, screen readers). */
export function fieldText(field: FieldDef, v: FieldValue | undefined, memberById: Record<string, Member>): string {
  if (isEmptyValue(v)) return "";
  switch (field.type) {
    case "select":
    case "multi_select":
      return selectedOptions(field, v)
        .map((o) => o.label)
        .join(", ");
    case "person":
      return typeof v === "string" ? (memberById[v]?.full_name ?? "Unknown member") : "";
    case "checkbox":
      return v ? "Yes" : "";
    case "number":
      return typeof v === "number" ? formatNumber(v) : String(v);
    case "date":
      return typeof v === "string" ? formatDate(v) : "";
    case "url":
      return typeof v === "string" ? hostOf(v) : "";
    default:
      return String(v);
  }
}

export const formatNumber = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// --- Dates ------------------------------------------------------------------

/** Last day (Sunday) of the calendar week containing `today`. */
export function endOfWeek(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  return addDays(today, (7 - day) % 7);
}

export function matchesDue(card: BoardCard, due: DueFilter, today: string): boolean {
  if (!card.due_date || card.completed || !today) return false;
  if (due === "overdue") return card.due_date < today;
  return card.due_date >= today && card.due_date <= endOfWeek(today);
}

export const DUE_FILTERS: { key: DueFilter; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "week", label: "Due this week" },
];

// --- Filtering --------------------------------------------------------------

export function filtersActive(f: BoardFilters): boolean {
  return countActiveFilters(f) > 0 || !!f.query.trim();
}

/** Number of active facet filters (search excluded). */
export function countActiveFilters(f: BoardFilters): number {
  return (
    (f.assignees.length ? 1 : 0) +
    (f.priorities.length ? 1 : 0) +
    (f.labels.length ? 1 : 0) +
    (f.due ? 1 : 0) +
    (f.hideCompleted ? 1 : 0)
  );
}

type Facet = "query" | "assignees" | "priorities" | "labels" | "due" | "hideCompleted";

/** Does a card pass every filter (optionally ignoring one facet, for faceted counts)? */
export function cardMatches(card: BoardCard, f: BoardFilters, today: string, ignore?: Facet): boolean {
  if (ignore !== "hideCompleted" && f.hideCompleted && card.completed) return false;
  if (ignore !== "assignees" && f.assignees.length && !f.assignees.includes(card.assignee_id ?? "none")) return false;
  if (ignore !== "priorities" && f.priorities.length && !f.priorities.includes(card.priority)) return false;
  if (ignore !== "labels" && f.labels.length) {
    const own = new Set(card.labels.map((l) => l.toLowerCase()));
    if (!f.labels.some((l) => own.has(l.toLowerCase()))) return false;
  }
  if (ignore !== "due" && f.due && !matchesDue(card, f.due, today)) return false;
  const q = ignore === "query" ? "" : f.query.trim().toLowerCase();
  if (q) {
    const hay = `${card.title}\n${card.description ?? ""}\n${card.labels.join(" ")}\n${card.subtasks.map((s) => s.title).join("\n")}`.toLowerCase();
    if (!q.split(/\s+/).every((term) => hay.includes(term))) return false;
  }
  return true;
}

export type FacetCounts = {
  assignees: Record<string, number>;
  priorities: Record<Priority, number>;
  labels: Record<string, number>;
  due: Record<DueFilter, number>;
  completed: number;
};

/** Counts per filter option, computed against all *other* active filters (like Linear). */
export function facetCounts(cards: BoardCard[], f: BoardFilters, today: string): FacetCounts {
  const out: FacetCounts = {
    assignees: {},
    priorities: { urgent: 0, high: 0, medium: 0, low: 0, none: 0 },
    labels: {},
    due: { overdue: 0, week: 0 },
    completed: 0,
  };
  for (const c of cards) {
    if (cardMatches(c, f, today, "assignees")) {
      const k = c.assignee_id ?? "none";
      out.assignees[k] = (out.assignees[k] ?? 0) + 1;
    }
    if (cardMatches(c, f, today, "priorities")) out.priorities[c.priority] = (out.priorities[c.priority] ?? 0) + 1;
    if (cardMatches(c, f, today, "labels")) {
      for (const l of new Set(c.labels)) out.labels[l] = (out.labels[l] ?? 0) + 1;
    }
    if (cardMatches(c, f, today, "due")) {
      if (matchesDue(c, "overdue", today)) out.due.overdue++;
      if (matchesDue(c, "week", today)) out.due.week++;
    }
    if (cardMatches(c, f, today, "hideCompleted") && c.completed) out.completed++;
  }
  return out;
}

/** Every label used on the board, case-insensitively de-duplicated, sorted. */
export function boardLabels(board: Board): string[] {
  const seen = new Map<string, string>();
  for (const c of board.cards) for (const l of c.labels) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// --- Sorting ----------------------------------------------------------------

export type SortKey =
  | "position"
  | "title"
  | "status"
  | "assignee"
  | "priority"
  | "due"
  | "labels"
  | "subtasks"
  | "created"
  | `field:${string}`;
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir } | null;
export type GroupBy = "none" | "status" | "assignee" | "priority" | "label";

export type ListCtx = { columns: BoardColumn[]; fields: FieldDef[]; memberById: Record<string, Member> };

export function subtaskProgress(card: BoardCard): { done: number; total: number } {
  return { done: card.subtasks.filter((s) => s.done).length, total: card.subtasks.length };
}

/** Sort value for a card; `null` = empty (always sorted last). */
function sortValue(card: BoardCard, key: SortKey, ctx: ListCtx, colIndex: Map<string, number>): string | number | null {
  switch (key) {
    case "position":
      return null;
    case "title":
      return card.title.toLowerCase();
    case "status":
      return colIndex.get(card.column_id) ?? 0;
    case "assignee":
      return card.assignee_id ? (ctx.memberById[card.assignee_id]?.full_name ?? "~").toLowerCase() : null;
    case "priority":
      return card.priority === "none" ? null : priorityMeta(card.priority).rank;
    case "due":
      return card.due_date;
    case "labels":
      return card.labels.length ? [...card.labels].sort().join(",").toLowerCase() : null;
    case "subtasks": {
      const { done, total } = subtaskProgress(card);
      return total ? done / total : null;
    }
    case "created":
      return card.created_at;
    default: {
      const field = ctx.fields.find((f) => `field:${f.id}` === key);
      if (!field) return null;
      const v = card.fields[field.id];
      if (isEmptyValue(v)) return null;
      if (field.type === "number") return typeof v === "number" ? v : Number(v);
      if (field.type === "checkbox") return v ? 1 : null;
      if (field.type === "select" || field.type === "multi_select") {
        const first = selectedOptions(field, v)[0];
        return first ? field.options.indexOf(first) : null;
      }
      return fieldText(field, v, ctx.memberById).toLowerCase();
    }
  }
}

/** Board order: by column order, then position within the column. */
export function boardOrder(cards: BoardCard[], columns: BoardColumn[]): BoardCard[] {
  const colIndex = new Map(columns.map((c, i) => [c.id, i]));
  return [...cards].sort((a, b) => (colIndex.get(a.column_id) ?? 0) - (colIndex.get(b.column_id) ?? 0) || byPosition(a, b));
}

export function sortCards(cards: BoardCard[], sort: SortState, ctx: ListCtx): BoardCard[] {
  const base = boardOrder(cards, ctx.columns);
  if (!sort || sort.key === "position") return base;
  const colIndex = new Map(ctx.columns.map((c, i) => [c.id, i]));
  const tie = new Map(base.map((c, i) => [c.id, i]));
  const dir = sort.dir === "asc" ? 1 : -1;
  const vals = new Map(base.map((c) => [c.id, sortValue(c, sort.key, ctx, colIndex)]));
  return base.sort((a, b) => {
    const va = vals.get(a.id) ?? null;
    const vb = vals.get(b.id) ?? null;
    if (va === null && vb === null) return tie.get(a.id)! - tie.get(b.id)!;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
    return cmp * dir || tie.get(a.id)! - tie.get(b.id)!;
  });
}

// --- Grouping ---------------------------------------------------------------

export type ListGroup = {
  key: string;
  label: string;
  /** Tailwind dot class for status groups. */
  dot?: string;
  priority?: Priority;
  assigneeId?: string | null;
  columnId?: string;
  labelName?: string | null;
  cards: BoardCard[];
};

export const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
  { key: "none", label: "No grouping" },
  { key: "status", label: "Status" },
  { key: "assignee", label: "Assignee" },
  { key: "priority", label: "Priority" },
  { key: "label", label: "Label" },
];

/** Group already-sorted cards. Status groups include empty columns so rows can be added to them. */
export function groupCards(sorted: BoardCard[], group: GroupBy, ctx: ListCtx, columnDot: (c: string | null) => string): ListGroup[] {
  switch (group) {
    case "none":
      return [{ key: "all", label: "All cards", cards: sorted }];
    case "status":
      return ctx.columns.map((col) => ({
        key: `status:${col.id}`,
        label: col.name,
        dot: columnDot(col.color),
        columnId: col.id,
        cards: sorted.filter((c) => c.column_id === col.id),
      }));
    case "priority":
      return PRIORITIES.map((p) => ({
        key: `priority:${p.key}`,
        label: p.label,
        priority: p.key,
        cards: sorted.filter((c) => c.priority === p.key),
      })).filter((g) => g.cards.length > 0);
    case "assignee": {
      const ids = [...new Set(sorted.map((c) => c.assignee_id).filter((x): x is string => !!x))];
      ids.sort((a, b) => (ctx.memberById[a]?.full_name ?? "~").localeCompare(ctx.memberById[b]?.full_name ?? "~"));
      const groups: ListGroup[] = ids.map((id) => ({
        key: `assignee:${id}`,
        label: ctx.memberById[id]?.full_name ?? "Former member",
        assigneeId: id,
        cards: sorted.filter((c) => c.assignee_id === id),
      }));
      const none = sorted.filter((c) => !c.assignee_id);
      if (none.length) groups.push({ key: "assignee:none", label: "Unassigned", assigneeId: null, cards: none });
      return groups;
    }
    case "label": {
      const names = new Map<string, string>();
      for (const c of sorted) for (const l of c.labels) if (!names.has(l.toLowerCase())) names.set(l.toLowerCase(), l);
      const groups: ListGroup[] = [...names.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([lower, label]) => ({
          key: `label:${lower}`,
          label,
          labelName: label,
          cards: sorted.filter((c) => c.labels.some((l) => l.toLowerCase() === lower)),
        }));
      const none = sorted.filter((c) => c.labels.length === 0);
      if (none.length) groups.push({ key: "label:none", label: "No label", labelName: null, cards: none });
      return groups;
    }
  }
}

// --- View preferences -------------------------------------------------------

export type ListView = "board" | "table";
export type ListPrefs = { view: ListView; sort: SortState; group: GroupBy; collapsed: string[] };

export const DEFAULT_PREFS: ListPrefs = { view: "board", sort: null, group: "none", collapsed: [] };

const PREFS_PREFIX = "worklio.lists.v2.";
const memoryPrefs = new Map<string, string>();
const prefListeners = new Set<() => void>();

function readPrefs(channelId: string): string {
  const key = PREFS_PREFIX + channelId;
  const mem = memoryPrefs.get(key);
  if (mem !== undefined) return mem;
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function parsePrefs(raw: string): ListPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<ListPrefs>;
    const groups = GROUP_OPTIONS.map((g) => g.key);
    return {
      view: p.view === "table" ? "table" : "board",
      sort:
        p.sort && typeof p.sort.key === "string" && (p.sort.dir === "asc" || p.sort.dir === "desc")
          ? { key: p.sort.key, dir: p.sort.dir }
          : null,
      group: p.group && groups.includes(p.group) ? p.group : "none",
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((x) => typeof x === "string").slice(0, 200) : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function subscribePrefs(cb: () => void) {
  prefListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(PREFS_PREFIX)) {
      if (e.key) memoryPrefs.delete(e.key);
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function writeListPrefs(channelId: string, patch: Partial<ListPrefs>) {
  const key = PREFS_PREFIX + channelId;
  const next = JSON.stringify({ ...parsePrefs(readPrefs(channelId)), ...patch });
  memoryPrefs.set(key, next);
  try {
    window.localStorage.setItem(key, next);
  } catch {
    // Private mode / quota: the in-memory copy keeps the preference for this session.
  }
  for (const l of prefListeners) l();
}

/** Per-channel view preferences (view, sort, grouping, collapsed groups). Raw strings keep the snapshot stable. */
export function useListPrefs(channelId: string): ListPrefs {
  const raw = useSyncExternalStore(
    subscribePrefs,
    () => readPrefs(channelId),
    () => "",
  );
  return parsePrefs(raw);
}

// --- Mentions ---------------------------------------------------------------

/** The `@query` being typed right before the caret, if any. Names may contain single spaces. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([^\s@](?:[^@\n]{0,30})?)?$/.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  if (/\s{2}/.test(query) || query.split(" ").length > 4) return null;
  return { start: before.length - query.length - 1, query };
}

export function matchMembers(members: Member[], query: string, limit = 8): Member[] {
  const q = query.trim().toLowerCase();
  const people = members.filter((m) => !m.is_bot);
  if (!q) return people.slice(0, limit);
  const starts: Member[] = [];
  const contains: Member[] = [];
  for (const m of people) {
    const name = m.full_name.toLowerCase();
    if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) starts.push(m);
    else if (name.includes(q) || (m.email ?? "").toLowerCase().startsWith(q)) contains.push(m);
  }
  return [...starts, ...contains].slice(0, limit);
}

export function sortedMembers(members: Member[]): Member[] {
  return members.filter((m) => !m.is_bot).sort((a, b) => a.full_name.localeCompare(b.full_name));
}
