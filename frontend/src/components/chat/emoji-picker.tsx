"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { EMOJI_CATEGORIES } from "@/lib/emoji";
import { media } from "@/lib/messages";

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // Focus search with a mouse/trackpad only; on touch it would cover the grid with the keyboard.
  useEffect(() => {
    if (media.finePointer()) search.current?.focus();
  }, []);
  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return null;
    const seen = new Set<string>();
    return EMOJI_CATEGORIES.flatMap((c) => c.items).filter((x) => {
      if (seen.has(x.e) || !x.n.includes(term)) return false;
      seen.add(x.e);
      return true;
    });
  }, [q]);

  const grid = (items: { e: string; n: string }[]) => (
    <div className="grid grid-cols-8 gap-0.5">
      {items.map((x) => (
        <button
          key={x.e + x.n}
          type="button"
          title={`:${x.n.split(" ")[0]}:`}
          onClick={() => onPick(x.e)}
          className="flex size-8 items-center justify-center rounded-md text-xl hover:bg-muted"
        >
          {x.e}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-[min(300px,calc(100vw-2rem))]">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search all emoji"
          className="h-9 w-full rounded-md border bg-background pr-2 pl-7 text-base outline-none sm:h-8 sm:text-sm focus:ring-2 focus:ring-link/40"
        />
      </div>
      <div className="max-h-72 overflow-y-auto px-2 pb-2">
        {results ? (
          results.length ? grid(results) : <p className="p-4 text-center text-sm text-muted-foreground">No emoji found</p>
        ) : (
          EMOJI_CATEGORIES.map((c) => (
            <div key={c.name} className="pb-2">
              <div className="sticky top-0 bg-popover py-1 text-xs font-bold text-muted-foreground">{c.name}</div>
              {grid(c.items)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
