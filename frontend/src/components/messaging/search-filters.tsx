"use client";

import { Calendar, ChevronDown, Hash, Lock, Paperclip, User, X } from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Search query syntax (parsed server-side):
 *   from:@name|user_id  in:#channel|channel_id  has:link|file|image|pin|reaction
 *   before:YYYY-MM-DD  after:YYYY-MM-DD  is:thread  "quoted phrases"
 */
export type HasFilter = "link" | "file" | "image" | "pin" | "reaction";
export const HAS_FILTERS: { key: HasFilter; label: string }[] = [
  { key: "link", label: "Links" },
  { key: "file", label: "Files" },
  { key: "image", label: "Images" },
  { key: "pin", label: "Pinned" },
  { key: "reaction", label: "Reactions" },
];

export type ParsedSearch = {
  text: string;
  from: string[];
  in: string[];
  has: HasFilter[];
  before: string | null;
  after: string | null;
  thread: boolean;
};

const OP_RE = /(?:^|\s)(from|in|has|before|after|is):("[^"]*"|\S+)/gi;

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: "", from: [], in: [], has: [], before: null, after: null, thread: false };
  const text = q.replace(OP_RE, (_, key: string, raw: string) => {
    const value = raw.replace(/^"|"$/g, "");
    switch (key.toLowerCase()) {
      case "from":
        out.from.push(value);
        break;
      case "in":
        out.in.push(value);
        break;
      case "has":
        if (HAS_FILTERS.some((h) => h.key === value)) out.has.push(value as HasFilter);
        break;
      case "before":
        out.before = value;
        break;
      case "after":
        out.after = value;
        break;
      case "is":
        if (value === "thread") out.thread = true;
        break;
    }
    return " ";
  });
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}

const quoteIfNeeded = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function buildSearch(p: ParsedSearch): string {
  return [
    p.text,
    ...p.from.map((v) => `from:${quoteIfNeeded(v)}`),
    ...p.in.map((v) => `in:${quoteIfNeeded(v)}`),
    ...p.has.map((v) => `has:${v}`),
    p.after ? `after:${p.after}` : "",
    p.before ? `before:${p.before}` : "",
    p.thread ? "is:thread" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Words and "quoted phrases" from the free text, for highlighting matches. */
export function highlightTerms(p: ParsedSearch): string[] {
  const phrases = [...p.text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const words = p.text
    .replace(/"[^"]*"/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w.length >= 2);
  return [...phrases, ...words];
}

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const iso = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};

/** Human description of a query, e.g. `budget from:@Ada in:#design`. */
export function describeSearch(q: string, labels: { user: (id: string) => string; channel: (id: string) => string }): string {
  const p = parseSearch(q);
  return buildSearch({
    ...p,
    from: p.from.map((v) => (isUuid(v) ? `@${labels.user(v)}` : v)),
    in: p.in.map((v) => (isUuid(v) ? `#${labels.channel(v)}` : v)),
  });
}

const chip =
  "flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-bold whitespace-nowrap hover:bg-muted data-popup-open:bg-muted";
const chipOn = "border-link/50 bg-link/10 text-link hover:bg-link/15";

/** From / In / Has / Date chips that edit the query syntax. */
export function SearchFilterBar({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  const ws = useWorkspace();
  const p = parseSearch(query);
  const update = (patch: Partial<ParsedSearch>) => onChange(buildSearch({ ...p, ...patch }));

  const userLabel = (v: string) => (isUuid(v) ? (ws.memberById[v]?.full_name ?? "someone") : v.replace(/^@/, ""));
  const channelLabel = (v: string) => {
    if (!isUuid(v)) return v.replace(/^#/, "");
    const c = ws.channels.find((x) => x.id === v);
    return c ? ws.channelLabel(c) : "conversation";
  };

  const dateLabel =
    p.after && p.before
      ? `${p.after} – ${p.before}`
      : p.after === iso(new Date())
        ? "Today"
        : p.after === daysAgo(7)
          ? "Last 7 days"
          : p.after === daysAgo(30)
            ? "Last 30 days"
            : p.after
              ? `After ${p.after}`
              : p.before
                ? `Before ${p.before}`
                : null;

  return (
    <div className="flex gap-1.5 overflow-x-auto border-b px-4 py-2 [scrollbar-width:none]">
      <PeoplePicker
        selected={p.from}
        label={p.from.length ? `From: ${p.from.map(userLabel).join(", ")}` : "From"}
        onChange={(from) => update({ from })}
      />
      <ChannelPicker
        selected={p.in}
        label={p.in.length ? `In: ${p.in.map(channelLabel).join(", ")}` : "In"}
        onChange={(inIds) => update({ in: inIds })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(chip, p.has.length && chipOn)}>
          <Paperclip className="size-3" />
          {p.has.length ? `Has: ${p.has.map((h) => HAS_FILTERS.find((x) => x.key === h)?.label).join(", ")}` : "Has"}
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          {HAS_FILTERS.map((h) => (
            <DropdownMenuCheckboxItem
              key={h.key}
              checked={p.has.includes(h.key)}
              onCheckedChange={(on) => update({ has: on ? [...p.has, h.key] : p.has.filter((x) => x !== h.key) })}
            >
              {h.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DateFilter
        label={dateLabel}
        after={p.after}
        before={p.before}
        onChange={(after, before) => update({ after, before })}
      />
      <button
        type="button"
        aria-pressed={p.thread}
        onClick={() => update({ thread: !p.thread })}
        className={cn(chip, p.thread && chipOn)}
      >
        In threads
      </button>
      {p.text && (p.from.length > 0 || p.in.length > 0 || p.has.length > 0 || p.after || p.before || p.thread) && (
        <button
          type="button"
          onClick={() => onChange(p.text)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-bold text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" /> Clear
        </button>
      )}
    </div>
  );
}

function PeoplePicker({ selected, label, onChange }: { selected: string[]; label: string; onChange: (ids: string[]) => void }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = ws.members
    .filter((m) => !q || m.full_name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 30);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger className={cn(chip, selected.length && chipOn)}>
        <User className="size-3" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-1 p-1.5">
        <input
          value={q}
          autoFocus
          placeholder="Find a person"
          onChange={(e) => setQ(e.target.value)}
          className="mb-1 h-8 w-full rounded-md border bg-transparent px-2 text-base outline-none focus:border-foreground/40 sm:text-sm"
        />
        <div className="max-h-60 overflow-y-auto">
          {ws.me && (
            <PickRow
              checked={selected.includes(ws.me.id)}
              onClick={() => onChange(toggle(selected, ws.me!.id))}
              icon={<UserAvatar id={ws.me.id} name={ws.me.full_name} size="sm" />}
              label={`${ws.me.full_name} (you)`}
            />
          )}
          {list
            .filter((m) => m.user_id !== ws.me?.id)
            .map((m) => (
              <PickRow
                key={m.user_id}
                checked={selected.includes(m.user_id)}
                onClick={() => onChange(toggle(selected, m.user_id))}
                icon={<UserAvatar id={m.user_id} name={m.full_name} size="sm" />}
                label={m.full_name}
              />
            ))}
          {list.length === 0 && <p className="p-2 text-center text-xs text-muted-foreground">No one matches</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChannelPicker({ selected, label, onChange }: { selected: string[]; label: string; onChange: (ids: string[]) => void }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = ws.channels
    .filter((c) => c.is_member)
    .filter((c) => !q || ws.channelLabel(c).toLowerCase().includes(q.toLowerCase()))
    .slice(0, 40);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger className={cn(chip, selected.length && chipOn)}>
        <Hash className="size-3" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-1 p-1.5">
        <input
          value={q}
          autoFocus
          placeholder="Find a conversation"
          onChange={(e) => setQ(e.target.value)}
          className="mb-1 h-8 w-full rounded-md border bg-transparent px-2 text-base outline-none focus:border-foreground/40 sm:text-sm"
        />
        <div className="max-h-60 overflow-y-auto">
          {list.map((c) => {
            const other = c.member_ids.find((id) => id !== ws.me?.id) ?? ws.me?.id ?? "";
            return (
              <PickRow
                key={c.id}
                checked={selected.includes(c.id)}
                onClick={() => onChange(toggle(selected, c.id))}
                icon={
                  c.kind === "dm" ? (
                    <UserAvatar id={other} name={ws.channelLabel(c)} size="sm" />
                  ) : c.kind === "private" ? (
                    <Lock className="size-3.5" />
                  ) : (
                    <Hash className="size-3.5" />
                  )
                }
                label={ws.channelLabel(c)}
              />
            );
          })}
          {list.length === 0 && <p className="p-2 text-center text-xs text-muted-foreground">No conversations match</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DateFilter({
  label,
  after,
  before,
  onChange,
}: {
  label: string | null;
  after: string | null;
  before: string | null;
  onChange: (after: string | null, before: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (a: string | null, b: string | null) => {
    onChange(a, b);
    setOpen(false);
  };
  const preset = "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn(chip, label && chipOn)}>
        <Calendar className="size-3" />
        {label ?? "Date"}
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-1 p-1.5">
        <button type="button" className={preset} onClick={() => pick(iso(new Date()), null)}>
          Today
        </button>
        <button type="button" className={preset} onClick={() => pick(daysAgo(1), iso(new Date()))}>
          Yesterday
        </button>
        <button type="button" className={preset} onClick={() => pick(daysAgo(7), null)}>
          Last 7 days
        </button>
        <button type="button" className={preset} onClick={() => pick(daysAgo(30), null)}>
          Last 30 days
        </button>
        {label && (
          <button type="button" className={preset} onClick={() => pick(null, null)}>
            Any time
          </button>
        )}
        <form
          className="mt-1 grid gap-2 border-t px-1 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            pick((data.get("after") as string) || null, (data.get("before") as string) || null);
          }}
        >
          <span className="text-xs font-bold text-muted-foreground">Custom range</span>
          <label className="grid gap-1 text-xs font-bold">
            After
            <input name="after" type="date" defaultValue={after ?? ""} className="h-8 rounded-md border bg-transparent px-2 text-sm font-normal" />
          </label>
          <label className="grid gap-1 text-xs font-bold">
            Before
            <input name="before" type="date" defaultValue={before ?? ""} className="h-8 rounded-md border bg-transparent px-2 text-sm font-normal" />
          </label>
          <button type="submit" className="h-8 rounded-md bg-send text-sm font-bold text-white hover:bg-send/90">
            Apply
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function PickRow({ checked, onClick, icon, label }: { checked: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", checked && "font-bold")}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <span className="text-link">✓</span>}
    </button>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
