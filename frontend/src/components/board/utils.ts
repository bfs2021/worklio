import { useSyncExternalStore } from "react";

import { COLUMN_COLORS, type Board, type BoardCard } from "./types";

const GAP = 1024;

/** Fractional position strictly between two neighbours (either may be missing). */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return GAP;
  if (before === undefined) return after! > 0 ? after! / 2 : after! - GAP;
  if (after === undefined) return before + GAP;
  return (before + after) / 2;
}

export const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/** Cards of one column in display order. */
export function columnCards(board: Board, columnId: string): BoardCard[] {
  return board.cards.filter((c) => c.column_id === columnId).sort(byPosition);
}

/** Sort, and default every Lists v2 field so older payloads (or partial events) still render. */
export function normalizeBoard(b: Board): Board {
  return {
    ...b,
    columns: [...b.columns].sort(byPosition),
    cards: b.cards.map(normalizeCard).sort(byPosition),
    fields: [...(b.fields ?? [])].map((f) => ({ ...f, options: f.options ?? [] })).sort(byPosition),
  };
}

export function normalizeCard(c: BoardCard): BoardCard {
  return {
    ...c,
    labels: c.labels ?? [],
    priority: c.priority ?? "none",
    subtasks: [...(c.subtasks ?? [])].sort(byPosition),
    fields: c.fields ?? {},
    comment_count: c.comment_count ?? 0,
    cover_color: c.cover_color ?? null,
  };
}

// --- Dates -----------------------------------------------------------------

export function localISO(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function subscribeToday(cb: () => void) {
  const id = window.setInterval(cb, 60_000);
  return () => window.clearInterval(id);
}
const getToday = () => localISO(new Date());
const getServerToday = () => "";

/** Today's local date as "YYYY-MM-DD" ("" during SSR). Strings are compared by value, so the snapshot is stable. */
export function useToday(): string {
  return useSyncExternalStore(subscribeToday, getToday, getServerToday);
}

export function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return localISO(new Date(y, m - 1, d + n));
}

export type DueStatus = "overdue" | "soon" | "later" | "done";

export function dueStatus(due: string, today: string, completed: boolean): DueStatus {
  if (completed) return "done";
  if (!today) return "later";
  if (due < today) return "overdue";
  if (due <= addDays(today, 2)) return "soon";
  return "later";
}

export function formatDue(due: string, today: string): string {
  if (today) {
    if (due === today) return "Today";
    if (due === addDays(today, 1)) return "Tomorrow";
    if (due === addDays(today, -1)) return "Yesterday";
  }
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = today && Number(today.slice(0, 4)) === y;
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

// --- Colours ---------------------------------------------------------------

export function columnDot(color: string | null): string {
  return COLUMN_COLORS.find((c) => c.key === color)?.dot ?? "bg-slate-400";
}

const LABEL_COLORS = [
  "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  "bg-pink-100 text-pink-800 dark:bg-pink-500/20 dark:text-pink-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
  "bg-orange-100 text-orange-900 dark:bg-orange-500/20 dark:text-orange-200",
];

export function labelColor(label: string): string {
  let h = 0;
  for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length];
}
