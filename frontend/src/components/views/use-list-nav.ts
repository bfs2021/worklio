"use client";

import { useEffect, useRef, useState } from "react";

const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const OVERLAY =
  "[data-slot=dialog-content], [data-slot=sheet-content], [data-slot=popover-content], [data-slot=dropdown-menu-content], [role=menu], [role=listbox]";

/**
 * Gmail-style list keyboard navigation for a view: J / K (or ↓ / ↑ while the list has focus)
 * move the selection, Enter opens it. Ignored while typing or with an overlay open.
 *
 * Rows opt in by spreading `rowProps(i)`; the selected row gets `data-selected`.
 */
export function useListNav({
  scope,
  count,
  onOpen,
}: {
  /** Unique per view, used to find rows in the DOM. */
  scope: string;
  count: number;
  onOpen: (index: number) => void;
}) {
  const [selected, setSelected] = useState(-1);
  const index = selected >= count ? count - 1 : selected;

  const latest = useRef({ index, count, onOpen });
  useEffect(() => {
    latest.current = { index, count, onOpen };
  });

  useEffect(() => {
    const focusRow = (i: number) => {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-nav-scope="${scope}"][data-nav-index="${i}"]`);
        el?.scrollIntoView({ block: "nearest" });
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.isComposing) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(TYPING) || document.querySelector(OVERLAY)) return;
      const { index: cur, count: n, onOpen: open } = latest.current;
      if (!n) return;
      const inList = !!el?.closest?.(`[data-nav-scope="${scope}"]`);
      const key = e.key;
      let next: number | null = null;
      if (key === "j" || key === "J" || (inList && key === "ArrowDown")) next = Math.min(n - 1, cur + 1);
      else if (key === "k" || key === "K" || (inList && key === "ArrowUp")) next = Math.max(0, cur < 0 ? 0 : cur - 1);
      else if (key === "Enter" && cur >= 0) {
        // Let buttons/links handle their own Enter.
        if (el?.closest?.("button, a, [role=button], [role=tab]")) return;
        e.preventDefault();
        open(cur);
        return;
      } else if (key === "Escape" && cur >= 0) {
        setSelected(-1);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      setSelected(next);
      focusRow(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope]);

  const rowProps = (i: number) => ({
    "data-nav-scope": scope,
    "data-nav-index": i,
    "data-selected": i === index ? "" : undefined,
  });

  return { index, setIndex: setSelected, rowProps };
}

/** Classes for a keyboard-selected row. */
export const SELECTED_ROW = "data-[selected]:bg-muted/70 data-[selected]:shadow-[inset_2px_0_0_var(--tab)]";
