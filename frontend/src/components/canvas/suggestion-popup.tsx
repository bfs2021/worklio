"use client";

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { UserAvatar } from "@/components/chat/user-avatar";
import { cn } from "@/lib/utils";

import type { MentionCandidate } from "./extensions";
import type { SlashItem } from "./slash-items";
import type { SuggestionStore } from "./suggestion-store";

const WIDTH = 300;
const MAX_HEIGHT = 340;

function SuggestionPopup<I>({
  store,
  id,
  label,
  empty,
  itemKey,
  renderItem,
  groupOf,
}: {
  store: SuggestionStore<I>;
  id: string;
  label: string;
  empty: string;
  itemKey: (item: I) => string;
  renderItem: (item: I, active: boolean) => ReactNode;
  groupOf?: (item: I) => string;
}) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const listRef = useRef<HTMLDivElement>(null);

  // Follow the caret while the page scrolls or resizes.
  useEffect(() => {
    if (!view.open) return;
    const fn = () => store.reposition();
    window.addEventListener("scroll", fn, true);
    window.addEventListener("resize", fn);
    return () => {
      window.removeEventListener("scroll", fn, true);
      window.removeEventListener("resize", fn);
    };
  }, [view.open, store]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${view.index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [view.index, view.items]);

  if (!view.open || !view.rect || typeof document === "undefined") return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(WIDTH, vw - 16);
  const left = Math.max(8, Math.min(view.rect.left, vw - width - 8));
  const below = vh - view.rect.bottom;
  const placeAbove = below < Math.min(MAX_HEIGHT, 240) && view.rect.top > below;
  const style: React.CSSProperties = placeAbove
    ? { left, width, bottom: vh - view.rect.top + 6, maxHeight: Math.min(MAX_HEIGHT, view.rect.top - 16) }
    : { left, width, top: view.rect.bottom + 6, maxHeight: Math.min(MAX_HEIGHT, below - 16) };

  let lastGroup = "";
  return createPortal(
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={label}
      style={style}
      className="fixed z-[60] overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl ring-1 ring-foreground/5 animate-in fade-in-0 zoom-in-95 duration-100"
      // Clicking inside must not steal focus from the editor.
      onMouseDown={(e) => e.preventDefault()}
    >
      {view.items.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground">{empty}</p>
      ) : (
        view.items.map((item, i) => {
          const group = groupOf?.(item) ?? "";
          const header = group && group !== lastGroup ? group : "";
          lastGroup = group;
          const active = i === view.index;
          return (
            <div key={itemKey(item)}>
              {header && (
                <p className="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{header}</p>
              )}
              <div
                role="option"
                id={`${id}-${i}`}
                data-index={i}
                aria-selected={active}
                onMouseMove={() => store.select(i)}
                onClick={() => store.pick(item)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm select-none",
                  active ? "bg-muted text-foreground" : "text-foreground/90",
                )}
              >
                {renderItem(item, active)}
              </div>
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
}

export function SlashMenu({ store }: { store: SuggestionStore<SlashItem> }) {
  return (
    <SuggestionPopup
      store={store}
      id="canvas-slash-menu"
      label="Insert block"
      empty="No matching blocks"
      itemKey={(i) => i.id}
      groupOf={(i) => i.group}
      renderItem={(item, active) => (
        <>
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md border bg-background",
              active && "border-link/40 text-link",
            )}
          >
            <item.icon className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{item.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
          </span>
          {item.hint && <kbd className="shrink-0 rounded border px-1 font-mono text-[10.5px] text-muted-foreground">{item.hint}</kbd>}
        </>
      )}
    />
  );
}

export function MentionMenu({ store }: { store: SuggestionStore<MentionCandidate> }) {
  return (
    <SuggestionPopup
      store={store}
      id="canvas-mention-menu"
      label="Mention someone"
      empty="No matching people"
      itemKey={(i) => i.id}
      renderItem={(m) => (
        <>
          <UserAvatar id={m.id} name={m.label} size="md" className="[&>span]:size-7" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{m.label}</span>
            {m.detail && <span className="block truncate text-xs text-muted-foreground">{m.detail}</span>}
          </span>
        </>
      )}
    />
  );
}
