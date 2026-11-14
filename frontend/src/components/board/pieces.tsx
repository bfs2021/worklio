"use client";

import { Check, ExternalLink, UserRound } from "lucide-react";

import { UserAvatar } from "@/components/chat/user-avatar";
import type { Member } from "@/lib/api";
import {
  PRIORITIES,
  colorMeta,
  formatDate,
  formatNumber,
  hostOf,
  isEmptyValue,
  priorityMeta,
  selectedOptions,
  sortedMembers,
} from "@/lib/lists";
import { cn } from "@/lib/utils";

import type { PickerOption } from "./picker";
import type { BoardColumn, FieldDef, FieldOption, FieldValue, Priority } from "./types";
import { columnDot, labelColor } from "./utils";

/** Linear-style priority glyph: three bars (filled by level), a warning square for urgent, a dash for none. */
export function PriorityIcon({ priority, className }: { priority: Priority; className?: string }) {
  const meta = priorityMeta(priority);
  if (priority === "urgent") {
    return (
      <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0", meta.text, className)} aria-hidden>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.25" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="1.05" fill="white" />
      </svg>
    );
  }
  if (priority === "none") {
    return (
      <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden>
        <path d="M3 8h2M7 8h2M11 8h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const level = 3 - meta.rank + 1; // high 3, medium 2, low 1
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0", meta.text, className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2.5 + i * 4}
          y={10 - i * 3.5}
          width="3"
          height={4 + i * 3.5}
          rx="1"
          fill="currentColor"
          opacity={i < level ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

export function PriorityBadge({ priority, showLabel = false, className }: { priority: Priority; showLabel?: boolean; className?: string }) {
  if (priority === "none" && !showLabel) return null;
  const meta = priorityMeta(priority);
  return (
    <span
      className={cn("inline-flex h-5 items-center gap-1 rounded-md text-[11px] font-semibold", showLabel ? "px-1.5" : "px-0.5", showLabel && meta.chip, className)}
      title={`Priority: ${meta.label}`}
    >
      <PriorityIcon priority={priority} className="size-3.5" />
      {showLabel ? meta.label : <span className="sr-only">Priority {meta.label}</span>}
    </span>
  );
}

/** Circular progress (subtasks). */
export function ProgressRing({ done, total, size = 14, className }: { done: number; total: number; size?: number; className?: string }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const pct = total ? done / total : 0;
  const complete = total > 0 && done === total;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("shrink-0 -rotate-90", className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        className={complete ? "text-emerald-600 dark:text-emerald-400" : "text-send"}
      />
    </svg>
  );
}

export function SubtaskBadge({ done, total, className }: { done: number; total: number; className?: string }) {
  if (!total) return null;
  const complete = done === total;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1 text-[11px] font-semibold tabular-nums",
        complete ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
        className,
      )}
      title={`${done} of ${total} subtasks done`}
    >
      <ProgressRing done={done} total={total} />
      {done}/{total}
      <span className="sr-only"> subtasks done</span>
    </span>
  );
}

export function OptionPill({ option, className }: { option: Pick<FieldOption, "label" | "color">; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 max-w-full items-center truncate rounded-md px-1.5 text-[11px] font-semibold", colorMeta(option.color).pill, className)}>
      {option.label}
    </span>
  );
}

export const ColorDot = ({ color, className }: { color: string | null; className?: string }) => (
  <span className={cn("size-2.5 shrink-0 rounded-full", colorMeta(color).dot, className)} aria-hidden />
);

/** Compact, read-only rendering of a custom field value. */
export function FieldValueView({
  field,
  value,
  memberById,
  compact = false,
  showName = false,
  className,
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  memberById: Record<string, Member>;
  compact?: boolean;
  /** Prefix plain values with the field name (card chips). */
  showName?: boolean;
  className?: string;
}) {
  if (isEmptyValue(value)) return null;
  const prefix = showName ? <span className="text-muted-foreground">{field.name}: </span> : null;
  switch (field.type) {
    case "select":
    case "multi_select": {
      const opts = selectedOptions(field, value);
      if (!opts.length) return null;
      return (
        <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1", compact && "flex-nowrap overflow-hidden", className)} title={showName ? field.name : undefined}>
          {opts.map((o) => (
            <OptionPill key={o.id} option={o} />
          ))}
        </span>
      );
    }
    case "person": {
      const m = typeof value === "string" ? memberById[value] : undefined;
      return (
        <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={showName ? `${field.name}: ${m?.full_name ?? "Unknown"}` : undefined}>
          {m ? <UserAvatar id={m.user_id} name={m.full_name} size="xs" /> : <UserRound className="size-3.5 text-muted-foreground" aria-hidden />}
          <span className="truncate">{m?.full_name ?? "Former member"}</span>
        </span>
      );
    }
    case "checkbox":
      return (
        <span className={cn("inline-flex items-center gap-1", className)}>
          <span className="flex size-3.5 items-center justify-center rounded-[4px] bg-send text-white" aria-hidden>
            <Check className="size-2.5" strokeWidth={3.5} />
          </span>
          {showName ? field.name : <span className="sr-only">Yes</span>}
        </span>
      );
    case "url": {
      const href = String(value);
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn("inline-flex min-w-0 items-center gap-1 text-link hover:underline", className)}
          title={href}
        >
          {prefix}
          <span className="truncate">{hostOf(href)}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      );
    }
    case "number":
      return (
        <span className={cn("truncate tabular-nums", className)}>
          {prefix}
          {typeof value === "number" ? formatNumber(value) : String(value)}
        </span>
      );
    case "date":
      return (
        <span className={cn("truncate tabular-nums", className)}>
          {prefix}
          {formatDate(String(value))}
        </span>
      );
    default:
      return (
        <span className={cn("truncate", className)} title={String(value)}>
          {prefix}
          {String(value)}
        </span>
      );
  }
}

// --- Picker option builders -------------------------------------------------

export const priorityOptions = (): PickerOption[] =>
  PRIORITIES.map((p) => ({ value: p.key, label: p.label, icon: <PriorityIcon priority={p.key} /> }));

export const columnOptions = (columns: BoardColumn[]): PickerOption[] =>
  columns.map((c) => ({ value: c.id, label: c.name, icon: <span className={cn("size-2.5 shrink-0 rounded-full", columnDot(c.color))} aria-hidden /> }));

export function memberOptions(members: Member[], meId: string | undefined, withNone = true): PickerOption[] {
  const people = sortedMembers(members);
  const me = people.find((m) => m.user_id === meId);
  const ordered = me ? [me, ...people.filter((m) => m !== me)] : people;
  const opts: PickerOption[] = ordered.map((m) => ({
    value: m.user_id,
    label: m.user_id === meId ? `${m.full_name} (you)` : m.full_name,
    keywords: m.email ?? "",
    icon: <UserAvatar id={m.user_id} name={m.full_name} size="sm" />,
  }));
  if (withNone) {
    opts.unshift({
      value: "",
      label: "Unassigned",
      icon: (
        <span className="flex size-[18px] items-center justify-center rounded border border-dashed text-muted-foreground" aria-hidden>
          <UserRound className="size-3" />
        </span>
      ),
    });
  }
  return opts;
}

export const fieldOptions = (field: FieldDef): PickerOption[] =>
  field.options.map((o) => ({ value: o.id, label: o.label, icon: <ColorDot color={o.color} /> }));

export const labelOptions = (labels: string[]): PickerOption[] =>
  labels.map((l) => ({ value: l, label: l, icon: <span className={cn("size-2.5 shrink-0 rounded-full", labelColor(l).split(" ")[0])} aria-hidden /> }));
