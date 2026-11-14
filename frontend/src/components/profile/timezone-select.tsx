"use client";

import { Check, ChevronsUpDown, Globe, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { allTimeZones, browserTimeZone, prettyZone, timeIn, useNow, zoneAbbr } from "./profile-utils";

const MAX_RESULTS = 120;

/** Searchable IANA time zone picker with a live local-time preview. `value` "" = not set. */
export function TimeZoneSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (tz: string) => void;
}) {
  const now = useNow();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const zones = allTimeZones();
    const term = q.trim().toLowerCase().replace(/\s+/g, "_");
    const filtered = term ? zones.filter((z) => z.toLowerCase().includes(term)) : zones;
    return filtered.slice(0, MAX_RESULTS);
  }, [q]);

  const detected = browserTimeZone();
  const choose = (tz: string) => {
    onChange(tz);
    setOpen(false);
  };

  const move = (delta: number) => {
    if (!results.length) return;
    const next = (active + delta + results.length) % results.length;
    setActive(next);
    requestAnimationFrame(() => document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" }));
  };

  const current = value ? timeIn(value, now) : null;

  return (
    <div className="space-y-1.5">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) {
            setQ("");
            const idx = allTimeZones().indexOf(value);
            setActive(idx >= 0 && idx < MAX_RESULTS ? idx : 0);
          }
        }}
      >
        <PopoverTrigger
          id={id}
          type="button"
          className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 text-left text-base outline-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
        >
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
            {value ? prettyZone(value) : "Choose a time zone"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] gap-0 p-0" align="start">
          <div className="relative border-b p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  move(1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  move(-1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (results[active]) choose(results[active]);
                }
              }}
              placeholder="Search city or region"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              aria-label="Search time zones"
              className="h-9 w-full rounded-md border bg-background pr-2 pl-7 text-base outline-none focus:ring-2 focus:ring-link/40 sm:h-8 sm:text-sm"
            />
          </div>
          {!q && detected !== value && (
            <button
              type="button"
              onClick={() => choose(detected)}
              className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm text-link hover:bg-muted"
            >
              <Globe className="size-4" /> Use my current time zone ({prettyZone(detected)})
            </button>
          )}
          <ul id={listId} role="listbox" aria-label="Time zones" className="max-h-64 overflow-y-auto p-1">
            {results.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">No time zones found</li>}
            {results.map((tz, i) => (
              <li
                key={tz}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={tz === value}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(tz)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  i === active && "bg-muted",
                )}
              >
                <Check className={cn("size-3.5 shrink-0", tz === value ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1 truncate">{prettyZone(tz)}</span>
                {now > 0 && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeIn(tz, now)}</span>
                )}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {value && current && (
        <p className="text-xs text-muted-foreground">
          It&apos;s <span className="font-medium text-foreground">{current}</span> there ({zoneAbbr(value, now)}).
        </p>
      )}
    </div>
  );
}
