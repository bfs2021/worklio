"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { addDays } from "./utils";

type Anchor = Element | null | React.RefObject<Element | null> | (() => Element | null);

/**
 * A popover for pickers. Either give it a `trigger` element (rendered via Base UI's render prop)
 * or an `anchor` to position against (used by table cells, which own their focus).
 * The first descendant marked `data-autofocus` receives focus on open.
 */
export function PickerPopover({
  open,
  onOpenChange,
  anchor,
  trigger,
  triggerContent,
  children,
  className,
  align = "start",
  restoreFocus = true,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor?: Anchor;
  trigger?: ReactElement;
  triggerContent?: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  /** Return focus to the trigger on close (table cells handle focus themselves). */
  restoreFocus?: boolean;
  label?: string;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      {trigger && <PopoverPrimitive.Trigger render={trigger}>{triggerContent}</PopoverPrimitive.Trigger>}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          align={align}
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            ref={popupRef}
            aria-label={label}
            initialFocus={() => popupRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? true}
            finalFocus={restoreFocus}
            className={cn(
              "z-50 flex max-h-[min(24rem,var(--available-height))] w-64 max-w-[calc(100vw-1rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-lg bg-popover text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-hidden duration-100 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              className,
            )}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export type PickerOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  /** Extra text to match when searching. */
  keywords?: string;
};

/**
 * Searchable listbox (combobox pattern): arrows / Home / End move, Enter picks, Escape closes.
 * Single mode calls `onPick` once; multiple mode toggles values and stays open.
 */
export function OptionList({
  options,
  selected,
  multiple = false,
  onPick,
  onClose,
  onCreate,
  createLabel = (q) => `Create “${q}”`,
  placeholder = "Search…",
  emptyText = "No matches",
  label,
  footer,
}: {
  options: PickerOption[];
  selected: string[];
  multiple?: boolean;
  onPick: (value: string) => void;
  onClose: () => void;
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  placeholder?: string;
  emptyText?: string;
  label: string;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q)) : options;
  const canCreate = !!onCreate && !!query.trim() && !options.some((o) => o.label.toLowerCase() === q);
  const count = filtered.length + (canCreate ? 1 : 0);
  const activeIdx = count === 0 ? -1 : Math.min(Math.max(active, 0), count - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function choose(index: number) {
    if (index < 0) return;
    if (index < filtered.length) onPick(filtered[index].value);
    else if (canCreate) {
      onCreate?.(query.trim());
      setQuery("");
      setActive(0);
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b p-1.5">
        <input
          data-autofocus
          role="combobox"
          aria-label={label}
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={activeIdx >= 0 ? `${id}-opt-${activeIdx}` : undefined}
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(count ? (activeIdx + 1) % count : 0);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(count ? (activeIdx - 1 + count) % count : 0);
            } else if (e.key === "Home" && !query) {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End" && !query) {
              e.preventDefault();
              setActive(count - 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              choose(activeIdx);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === "Tab") {
              onClose();
            }
          }}
          className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul
        ref={listRef}
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      >
        {filtered.map((o, i) => {
          const isSel = selected.includes(o.value);
          return (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={isSel}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== activeIdx && setActive(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none",
                i === activeIdx && "bg-accent text-accent-foreground",
              )}
            >
              {multiple && (
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    isSel ? "border-send bg-send text-white" : "border-muted-foreground/40",
                  )}
                  aria-hidden
                >
                  {isSel && <Check className="size-3" strokeWidth={3} />}
                </span>
              )}
              {o.icon}
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
              {!multiple && isSel && <Check className="size-4 shrink-0 text-send" aria-hidden />}
            </li>
          );
        })}
        {canCreate && (
          <li
            id={`${id}-opt-${filtered.length}`}
            data-index={filtered.length}
            role="option"
            aria-selected={false}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => activeIdx !== filtered.length && setActive(filtered.length)}
            onClick={() => choose(filtered.length)}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none",
              activeIdx === filtered.length && "bg-accent text-accent-foreground",
            )}
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{createLabel(query.trim())}</span>
          </li>
        )}
        {count === 0 && <li className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</li>}
      </ul>
      {footer && <div className="border-t p-1">{footer}</div>}
    </div>
  );
}

/** Quick date choices + a native date input. `value` is "YYYY-MM-DD" or "". */
export function DatePanel({
  value,
  today,
  onChange,
  onClose,
  label = "Date",
}: {
  value: string;
  today: string;
  onChange: (v: string | null) => void;
  onClose: () => void;
  label?: string;
}) {
  const [text, setText] = useState(value);
  const base = today || new Date().toISOString().slice(0, 10);
  const [y, m, d] = base.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const nextMonday = addDays(base, ((8 - dow) % 7) || 7);
  const quick = [
    { label: "Today", value: base },
    { label: "Tomorrow", value: addDays(base, 1) },
    { label: "Next week", value: nextMonday },
    { label: "In 2 weeks", value: addDays(base, 14) },
  ];

  return (
    <div className="grid gap-2 p-2">
      <input
        data-autofocus
        type="date"
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onChange(text || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <div className="grid grid-cols-2 gap-1">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => onChange(q.value)}
            className={cn(
              "rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              value === q.value && "bg-send/10 font-semibold",
            )}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 border-t pt-2">
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" /> Clear
          </button>
        )}
        <button
          type="button"
          disabled={text === value}
          onClick={() => onChange(text || null)}
          className="ml-auto rounded-md bg-send px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-send/90 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        >
          Set date
        </button>
      </div>
    </div>
  );
}
