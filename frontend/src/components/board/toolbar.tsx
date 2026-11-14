"use client";

import { CalendarClock, ChevronDown, EyeOff, KanbanSquare, Search, Settings2, Table2, Tags, UserRound, X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Member } from "@/lib/api";
import {
  DUE_FILTERS,
  PRIORITIES,
  countActiveFilters,
  filtersActive,
  priorityMeta,
  type FacetCounts,
  type ListView,
} from "@/lib/lists";
import { cn } from "@/lib/utils";

import { OptionList, PickerPopover, type PickerOption } from "./picker";
import { PriorityIcon, labelOptions, memberOptions } from "./pieces";
import { EMPTY_FILTERS, type BoardFilters, type DueFilter, type Priority } from "./types";

type SetFilters = (f: (prev: BoardFilters) => BoardFilters) => void;

/** Board | Table segmented control (radio group: arrows switch, like native radios). */
export function ViewSwitcher({ view, onChange }: { view: ListView; onChange: (v: ListView) => void }) {
  const items: { key: ListView; label: string; icon: ReactNode }[] = [
    { key: "board", label: "Board", icon: <KanbanSquare className="size-3.5" aria-hidden /> },
    { key: "table", label: "Table", icon: <Table2 className="size-3.5" aria-hidden /> },
  ];
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      const next = view === "board" ? "table" : "board";
      onChange(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
    }
  }
  return (
    <div role="radiogroup" aria-label="View" onKeyDown={onKeyDown} className="inline-flex h-8 shrink-0 items-center rounded-lg bg-muted p-0.5">
      {items.map((it) => {
        const on = it.key === view;
        return (
          <button
            key={it.key}
            type="button"
            role="radio"
            data-view={it.key}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(it.key)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              on ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

const chipClass = (on: boolean) =>
  cn(
    "inline-flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
    on ? "border-send/40 bg-send/10 text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );

function FacetPicker({
  label,
  icon,
  summary,
  active,
  options,
  selected,
  multiple = true,
  onToggle,
  onClear,
  emptyText,
}: {
  label: string;
  icon: ReactNode;
  summary: string;
  active: boolean;
  options: PickerOption[];
  selected: string[];
  multiple?: boolean;
  onToggle: (value: string) => void;
  onClear: () => void;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PickerPopover
      open={open}
      onOpenChange={setOpen}
      label={`Filter by ${label.toLowerCase()}`}
      trigger={<button type="button" className={chipClass(active)} aria-label={active ? `${label}: ${summary}` : `Filter by ${label.toLowerCase()}`} />}
      triggerContent={
        <>
          {icon}
          <span className="truncate">{active ? summary : label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
        </>
      }
    >
      <OptionList
        label={`Filter by ${label.toLowerCase()}`}
        options={options}
        selected={selected}
        multiple={multiple}
        emptyText={emptyText}
        placeholder={`Filter ${label.toLowerCase()}…`}
        onPick={(v) => {
          onToggle(v);
          if (!multiple) setOpen(false);
        }}
        onClose={() => setOpen(false)}
        footer={
          active ? (
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="w-full rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Clear {label.toLowerCase()} filter
            </button>
          ) : null
        }
      />
    </PickerPopover>
  );
}

const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const countHint = (n: number | undefined) => String(n ?? 0);

export function BoardToolbar({
  view,
  onViewChange,
  filters,
  setFilters,
  counts,
  members,
  memberById,
  me,
  labels,
  visible,
  total,
  canManageFields,
  onManageFields,
  fieldCount,
}: {
  view: ListView;
  onViewChange: (v: ListView) => void;
  filters: BoardFilters;
  setFilters: SetFilters;
  counts: FacetCounts;
  members: Member[];
  memberById: Record<string, Member>;
  me: { id: string } | null;
  labels: string[];
  visible: number;
  total: number;
  canManageFields: boolean;
  onManageFields: () => void;
  fieldCount: number;
}) {
  const active = filtersActive(filters);
  const facetCount = countActiveFilters(filters);
  const mineOnly = !!me && filters.assignees.length === 1 && filters.assignees[0] === me.id;

  const assigneeOpts = memberOptions(members, me?.id).map((o) => ({ ...o, value: o.value || "none", hint: countHint(counts.assignees[o.value || "none"]) }));
  const assigneeSummary =
    filters.assignees.length === 1
      ? filters.assignees[0] === "none"
        ? "Unassigned"
        : filters.assignees[0] === me?.id
          ? "Me"
          : (memberById[filters.assignees[0]]?.full_name ?? "1 person")
      : `${filters.assignees.length} people`;

  const priorityOpts: PickerOption[] = PRIORITIES.map((p) => ({
    value: p.key,
    label: p.label,
    icon: <PriorityIcon priority={p.key} />,
    hint: countHint(counts.priorities[p.key]),
  }));
  const prioritySummary =
    filters.priorities.length === 1 ? priorityMeta(filters.priorities[0]).label : `${filters.priorities.length} priorities`;

  // Keep selected labels listed even if no card uses them any more, so they can be un-ticked.
  const allLabels = [...labels, ...filters.labels.filter((l) => !labels.some((x) => x.toLowerCase() === l.toLowerCase()))];
  const labelOpts = labelOptions(allLabels).map((o) => ({ ...o, hint: countHint(counts.labels[o.value]) }));
  const labelSummary = filters.labels.length === 1 ? filters.labels[0] : `${filters.labels.length} labels`;

  const dueOpts: PickerOption[] = DUE_FILTERS.map((d) => ({ value: d.key, label: d.label, hint: countHint(counts.due[d.key]) }));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-5" role="toolbar" aria-label="Board view and filters">
      <ViewSwitcher view={view} onChange={onViewChange} />
      <div className="relative min-w-0 flex-1 basis-36 sm:max-w-56">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filters.query) {
              e.stopPropagation();
              setFilters((f) => ({ ...f, query: "" }));
            }
          }}
          placeholder="Search cards"
          aria-label="Search cards"
          className="h-8 pl-8"
        />
      </div>

      {me && (
        <button
          type="button"
          aria-pressed={mineOnly}
          onClick={() => setFilters((f) => ({ ...f, assignees: mineOnly ? [] : [me.id] }))}
          className={chipClass(mineOnly)}
        >
          <UserAvatar id={me.id} name={memberById[me.id]?.full_name ?? "Me"} size="xs" />
          <span>Mine</span>
          <span className="text-[11px] font-normal text-muted-foreground tabular-nums">{counts.assignees[me.id] ?? 0}</span>
        </button>
      )}

      <FacetPicker
        label="Assignee"
        icon={<UserRound className="size-3.5 shrink-0" aria-hidden />}
        summary={assigneeSummary}
        active={filters.assignees.length > 0 && !mineOnly}
        options={assigneeOpts}
        selected={filters.assignees}
        onToggle={(v) => setFilters((f) => ({ ...f, assignees: toggleIn(f.assignees, v) }))}
        onClear={() => setFilters((f) => ({ ...f, assignees: [] }))}
      />
      <FacetPicker
        label="Priority"
        icon={<PriorityIcon priority={filters.priorities.length === 1 ? filters.priorities[0] : "high"} className="size-3.5" />}
        summary={prioritySummary}
        active={filters.priorities.length > 0}
        options={priorityOpts}
        selected={filters.priorities}
        onToggle={(v) => setFilters((f) => ({ ...f, priorities: toggleIn(f.priorities, v as Priority) }))}
        onClear={() => setFilters((f) => ({ ...f, priorities: [] }))}
      />
      <FacetPicker
        label="Label"
        icon={<Tags className="size-3.5 shrink-0" aria-hidden />}
        summary={labelSummary}
        active={filters.labels.length > 0}
        options={labelOpts}
        selected={filters.labels}
        emptyText="No labels on this board yet"
        onToggle={(v) => setFilters((f) => ({ ...f, labels: toggleIn(f.labels, v) }))}
        onClear={() => setFilters((f) => ({ ...f, labels: [] }))}
      />
      <FacetPicker
        label="Due"
        icon={<CalendarClock className="size-3.5 shrink-0" aria-hidden />}
        summary={DUE_FILTERS.find((d) => d.key === filters.due)?.label ?? "Due"}
        active={!!filters.due}
        options={dueOpts}
        selected={filters.due ? [filters.due] : []}
        multiple={false}
        onToggle={(v) => setFilters((f) => ({ ...f, due: f.due === v ? null : (v as DueFilter) }))}
        onClear={() => setFilters((f) => ({ ...f, due: null }))}
      />
      <button
        type="button"
        aria-pressed={filters.hideCompleted}
        onClick={() => setFilters((f) => ({ ...f, hideCompleted: !f.hideCompleted }))}
        className={chipClass(filters.hideCompleted)}
      >
        <EyeOff className="size-3.5" aria-hidden /> <span>Hide done</span>
        <span className="text-[11px] font-normal text-muted-foreground tabular-nums">{counts.completed}</span>
      </button>

      {active && (
        <>
          <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {visible === 0 ? "No cards match" : `${visible} of ${total}`}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setFilters(() => EMPTY_FILTERS)}>
            <X /> Clear all{facetCount > 1 ? ` (${facetCount})` : ""}
          </Button>
        </>
      )}

      {canManageFields && (
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onManageFields}>
          <Settings2 /> Fields
          {fieldCount > 0 && <span className="text-muted-foreground tabular-nums">{fieldCount}</span>}
        </Button>
      )}
    </div>
  );
}
