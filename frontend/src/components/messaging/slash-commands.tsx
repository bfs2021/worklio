"use client";

import {
  AlarmClock,
  BarChart3,
  BellOff,
  CalendarClock,
  Coffee,
  DoorOpen,
  Moon,
  Smile,
  Sparkles,
  Type,
  UserPlus,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { askWorklio } from "@/components/ai/composer-assistant";
import { api, type Channel, type Member, type User } from "@/lib/api";
import { messaging } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { describeWhen, parseDuration, splitReminder } from "./natural-time";

export type SlashCommand = {
  name: string;
  /** Argument hint shown after the name; omitted = runs as soon as it's picked. */
  args?: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Hidden in DMs (channel-only commands). */
  channelsOnly?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "remind", args: "[what] [when]", description: "Set a reminder — “/remind call Sam in 20 minutes”", icon: AlarmClock },
  { name: "poll", args: "\"Question\" \"Option\" \"Option\"", description: "Create a poll", icon: BarChart3 },
  { name: "schedule", args: "[message]", description: "Schedule a message to send later", icon: CalendarClock },
  { name: "dnd", args: "30m | 1h | until 5pm | off", description: "Pause notifications", icon: BellOff },
  { name: "status", args: ":emoji: [text] | clear", description: "Set your status", icon: Smile },
  { name: "away", description: "Toggle your away status", icon: Moon },
  { name: "mute", description: "Mute or unmute this conversation", icon: VolumeX },
  { name: "topic", args: "[text]", description: "Set the channel topic", icon: Type, channelsOnly: true },
  { name: "invite", args: "@person", description: "Add people to this channel", icon: UserPlus, channelsOnly: true },
  { name: "leave", description: "Leave this channel", icon: DoorOpen, channelsOnly: true },
  { name: "shrug", args: "[message]", description: "Append ¯\\_(ツ)_/¯ to your message", icon: Coffee },
  { name: "ai", args: "[question]", description: "Ask Worklio AI", icon: Sparkles },
];

/** Matches the composer while the user is still typing the command name. */
export const SLASH_QUERY = /^\/([a-z]*)$/i;

export function filterCommands(query: string, isDM: boolean): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => !(isDM && c.channelsOnly))
    .filter((c) => c.name.startsWith(q) || (q.length > 1 && c.description.toLowerCase().includes(q)))
    .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)));
}

export function SlashMenu({
  commands,
  index,
  onPick,
  onHover,
}: {
  commands: SlashCommand[];
  index: number;
  onPick: (c: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <div
      ref={list}
      id="slash-menu"
      role="listbox"
      aria-label="Commands"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-80 w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border bg-popover py-1 shadow-lg"
    >
      <div className="px-3 py-1 text-xs font-bold text-muted-foreground">Commands</div>
      {commands.map((c, i) => (
        <button
          key={c.name}
          type="button"
          role="option"
          id={`slash-${c.name}`}
          data-index={i}
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
            i === index ? "bg-link text-white" : "hover:bg-muted",
          )}
        >
          <c.icon className={cn("size-4 shrink-0", i === index ? "text-white" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1">
            <span className="font-bold">/{c.name}</span>
            {c.args && <span className={cn("ml-1.5 text-xs", i === index ? "text-white/80" : "text-muted-foreground")}>{c.args}</span>}
            <span className={cn("block truncate text-xs", i === index ? "text-white/85" : "text-muted-foreground")}>
              {c.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// --- Execution ---------------------------------------------------------------------------------

export type SlashContext = {
  workspaceId: string;
  channel: Channel | undefined;
  parentId?: string;
  me: User | null;
  members: Member[];
  setMe: (u: User) => void;
  reloadChannels: () => Promise<void>;
  leaveChannel: () => void;
};

/** What the composer should do after a command ran. */
export type SlashOutcome =
  | { kind: "done" }
  /** Keep the composer text (usage error): the toast explains what's wrong. */
  | { kind: "keep" }
  /** Post this text as a normal message. */
  | { kind: "send"; body: string }
  | { kind: "poll"; question?: string; options?: string[] }
  | { kind: "schedule"; body: string };

/** Parse "/name rest". Returns null for text that isn't a known command. */
export function parseSlash(text: string): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase());
  return command ? { command, arg: (m[2] ?? "").trim() } : null;
}

/** Split `"Question" "A" "B"` (straight or curly quotes); falls back to `|` separators. */
export function parsePollArgs(arg: string): { question?: string; options: string[] } {
  const quoted = [...arg.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1].trim()).filter(Boolean);
  const parts = quoted.length ? quoted : arg.split("|").map((s) => s.trim()).filter(Boolean);
  return { question: parts[0], options: parts.slice(1, 11) };
}

const STATUS_EMOJI_RE = /^(:[a-z0-9_+-]+:|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/iu;

export async function runSlash(text: string, ctx: SlashContext): Promise<SlashOutcome> {
  const parsed = parseSlash(text);
  if (!parsed) {
    const name = /^\/(\S+)/.exec(text.trim())?.[1] ?? "";
    toast.error(`/${name} isn't a command. Start with // to send a message that begins with “/”.`);
    return { kind: "keep" };
  }
  const { command, arg } = parsed;
  const channel = ctx.channel;
  const isDM = channel?.kind === "dm";
  if (command.channelsOnly && isDM) {
    toast.error(`/${command.name} only works in channels.`);
    return { kind: "keep" };
  }

  try {
    switch (command.name) {
      case "remind": {
        const r = splitReminder(arg);
        if (!r) {
          toast.error("Try “/remind review the deck tomorrow at 9am” or “/remind stand up in 20 minutes”.");
          return { kind: "keep" };
        }
        if (r.when.getTime() <= Date.now()) {
          toast.error("That time has already passed.");
          return { kind: "keep" };
        }
        await messaging.remind(ctx.workspaceId, { text: r.text, remind_at: r.when.toISOString() });
        toast.success(`I'll remind you “${r.text}” ${describeWhen(r.when)}`);
        return { kind: "done" };
      }
      case "poll": {
        const { question, options } = parsePollArgs(arg);
        if (!question || options.length < 2) return { kind: "poll", question, options };
        if (!channel) return { kind: "keep" };
        await messaging.createPoll(channel.id, { question, options, parent_id: ctx.parentId ?? null });
        return { kind: "done" };
      }
      case "schedule":
        return { kind: "schedule", body: arg };
      case "dnd": {
        if (/^(off|stop|end|resume)$/i.test(arg)) {
          ctx.setMe(await messaging.setDnd(null));
          toast.success("Notifications resumed");
          return { kind: "done" };
        }
        const until = parseDuration(arg || "1h");
        if (!until || until.getTime() <= Date.now()) {
          toast.error("Try “/dnd 30m”, “/dnd 2h”, “/dnd until 5pm” or “/dnd off”.");
          return { kind: "keep" };
        }
        ctx.setMe(await messaging.setDnd(until.toISOString()));
        toast.success(`Notifications paused until ${describeWhen(until)}`);
        return { kind: "done" };
      }
      case "status": {
        if (!arg || /^(clear|off|none)$/i.test(arg)) {
          ctx.setMe(await messaging.clearStatus());
          toast.success("Status cleared");
          return { kind: "done" };
        }
        const em = STATUS_EMOJI_RE.exec(arg);
        const emoji = em ? em[1] : "💬";
        const statusText = (em ? arg.slice(em[0].length) : arg).trim().slice(0, 100) || null;
        ctx.setMe(await messaging.setStatus({ emoji, text: statusText }));
        toast.success("Status updated");
        return { kind: "done" };
      }
      case "away": {
        const away = ctx.me?.status_text === "Away";
        ctx.setMe(away ? await messaging.clearStatus() : await messaging.setStatus({ emoji: "🌙", text: "Away" }));
        toast.success(away ? "Welcome back! You're active" : "You're set to away");
        return { kind: "done" };
      }
      case "mute": {
        if (!channel) return { kind: "keep" };
        const prefs = await messaging.channelPrefs(ctx.workspaceId).catch(() => []);
        const muted = !!prefs.find((p) => p.channel_id === channel.id)?.muted;
        await messaging.setChannelPrefs(channel.id, { muted: !muted });
        toast.success(muted ? "Conversation unmuted" : "Conversation muted — you won't get notifications from it");
        return { kind: "done" };
      }
      case "topic": {
        if (!channel) return { kind: "keep" };
        await api(`/channels/${channel.id}`, { method: "PATCH", body: JSON.stringify({ topic: arg.slice(0, 250) }) });
        toast.success(arg ? "Topic updated" : "Topic cleared");
        return { kind: "done" };
      }
      case "invite": {
        if (!channel) return { kind: "keep" };
        const people = findPeople(arg, ctx.members).filter((p) => !channel.member_ids.includes(p.user_id));
        if (!people.length) {
          toast.error(arg ? "Nobody new to add — use “/invite @Name”." : "Who should join? Try “/invite @Name”.");
          return { kind: "keep" };
        }
        for (const p of people) {
          await api(`/channels/${channel.id}/members`, { method: "POST", body: JSON.stringify({ user_id: p.user_id }) });
        }
        toast.success(`Added ${people.map((p) => p.full_name).join(", ")} to #${channel.name}`);
        return { kind: "done" };
      }
      case "leave": {
        if (!channel) return { kind: "keep" };
        await api(`/channels/${channel.id}/members/me`, { method: "DELETE" });
        toast.success(`You left #${channel.name}`);
        await ctx.reloadChannels().catch(() => {});
        ctx.leaveChannel();
        return { kind: "done" };
      }
      case "shrug":
        return { kind: "send", body: `${arg ? `${arg} ` : ""}¯\\_(ツ)_/¯` };
      case "ai":
        // Normally intercepted by the composer; this is the fallback path. Opens Ask Worklio.
        askWorklio(arg);
        return { kind: "done" };
    }
  } catch (err) {
    toast.error(`/${command.name} failed: ${errorMessage(err)}`);
    return { kind: "keep" };
  }
  return { kind: "keep" };
}

/** "@Ada Lovelace @Alan" → members, longest names first so "Ada Lovelace" beats "Ada". */
function findPeople(arg: string, members: Member[]): Member[] {
  const found = new Map<string, Member>();
  let rest = ` ${arg} `;
  const sorted = [...members].sort((a, b) => b.full_name.length - a.full_name.length);
  for (const m of sorted) {
    const needle = `@${m.full_name.toLowerCase()}`;
    const i = rest.toLowerCase().indexOf(needle);
    if (i >= 0 && !/[\w]/.test(rest[i + needle.length] ?? " ")) {
      found.set(m.user_id, m);
      rest = rest.slice(0, i) + rest.slice(i + needle.length);
    }
  }
  // Also accept a bare email or first name without "@".
  for (const word of rest.split(/[\s,]+/).filter(Boolean)) {
    const w = word.replace(/^@/, "").toLowerCase();
    const hit = members.find((m) => m.email?.toLowerCase() === w || m.full_name.toLowerCase().split(" ")[0] === w);
    if (hit) found.set(hit.user_id, hit);
  }
  return [...found.values()];
}
