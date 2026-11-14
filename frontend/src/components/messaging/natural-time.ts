/**
 * Tiny natural-language time parser for reminders, /dnd and scheduled send.
 *
 *   in 20 minutes · in 2h · in an hour · in 3 days
 *   at 3pm · at 15:30 · 9am · noon · tonight
 *   tomorrow · tomorrow 9am · tomorrow at 9:30am
 *   next monday · monday at 2pm · on friday · next week
 *
 * All times are local to the browser. Returns null unless the whole phrase is understood.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

const UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, wks: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

const DEFAULT_HOUR = 9;

function weekdayIndex(word: string): number | null {
  const i = WEEKDAYS.indexOf(word);
  if (i >= 0) return i;
  return WEEKDAY_SHORT[word] ?? null;
}

type Clock = { h: number; m: number };

/** "3pm", "3:30 pm", "15:30", "noon", "midnight", "9" (only with `bareOk`). */
function parseClock(s: string, bareOk: boolean): Clock | null {
  const t = s.trim();
  if (t === "noon") return { h: 12, m: 0 };
  if (t === "midnight") return { h: 0, m: 0 };
  if (t === "morning") return { h: 9, m: 0 };
  if (t === "afternoon") return { h: 14, m: 0 };
  if (t === "evening") return { h: 18, m: 0 };
  if (t === "tonight" || t === "night") return { h: 20, m: 0 };
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/.exec(t);
  if (!match) return null;
  let h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  const mer = match[3]?.[0];
  if (m > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "p" && h !== 12) h += 12;
    if (mer === "a" && h === 12) h = 0;
  } else {
    if (!match[2] && !bareOk) return null;
    if (h > 23) return null;
  }
  return { h, m };
}

function at(base: Date, c: Clock): Date {
  const d = new Date(base);
  d.setHours(c.h, c.m, 0, 0);
  return d;
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

/** Day phrase → a date (time-of-day ignored), or null. `next` forces the following week. */
function parseDay(s: string, now: Date): Date | null {
  const t = s.trim().replace(/^on\s+/, "");
  if (t === "today") return now;
  if (t === "tonight") return now;
  if (t === "tomorrow" || t === "tmrw" || t === "tmr") return addDays(now, 1);
  if (t === "next week") {
    // Next Monday.
    const diff = ((1 - now.getDay() + 7) % 7) || 7;
    return addDays(now, diff);
  }
  const next = /^next\s+(\w+)$/.exec(t);
  const dayWord = next ? next[1] : t;
  const wd = weekdayIndex(dayWord);
  if (wd === null) return null;
  const diff = ((wd - now.getDay() + 7) % 7) || 7;
  return addDays(now, diff);
}

export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "");
  if (!s) return null;

  // Relative: "in 20 minutes", "in an hour", "20m", "in 1h30m".
  const rel = /^(?:in\s+)?((?:(?:\d+(?:\.\d+)?|an?|half an?)\s*[a-z]+\s*(?:and\s+)?)+)$/.exec(s);
  if (rel && (s.startsWith("in ") || /^\d/.test(s))) {
    let total = 0;
    let matched = "";
    let valid = true;
    for (const part of rel[1].matchAll(/(\d+(?:\.\d+)?|half an?|an?)\s*([a-z]+)\s*(?:and\s+)?/g)) {
      const unit = UNIT_MS[part[2]];
      if (!unit) {
        // e.g. "9am": not a duration; let the clock parser below have it.
        valid = false;
        break;
      }
      const n = part[1].startsWith("half") ? 0.5 : part[1] === "a" || part[1] === "an" ? 1 : Number(part[1]);
      total += n * unit;
      matched += part[0];
    }
    if (valid && matched.trim() === rel[1].trim() && total > 0) return new Date(now.getTime() + total);
  }

  // "tonight" alone.
  if (s === "tonight") {
    const d = at(now, { h: 20, m: 0 });
    return d > now ? d : null;
  }

  // "<day> [at] <time>" or "<time> <day>" or "<day>" or "[at] <time>".
  const tryDayTime = (dayPart: string, timePart: string | null): Date | null => {
    const day = parseDay(dayPart, now);
    if (!day) return null;
    if (timePart === null) {
      const isToday = day.toDateString() === now.toDateString();
      if (dayPart.trim() === "tonight") return at(now, { h: 20, m: 0 });
      return isToday ? null : at(day, { h: DEFAULT_HOUR, m: 0 });
    }
    const clock = parseClock(timePart.replace(/^at\s+/, ""), true);
    return clock ? at(day, clock) : null;
  };

  // Whole string is a day.
  const dayOnly = tryDayTime(s, null);
  if (dayOnly) return dayOnly;

  // Split into day + time at every word boundary.
  const words = s.split(" ");
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(" ");
    const right = words.slice(i).join(" ");
    const a = tryDayTime(left, right);
    if (a) return a;
    const b = tryDayTime(right, left.replace(/^at\s+/, ""));
    if (b) return b;
  }

  // Time only: today, or tomorrow if that time has passed.
  const clock = parseClock(s.replace(/^at\s+/, ""), s.startsWith("at "));
  if (clock) {
    const d = at(now, clock);
    return d > now ? d : addDays(d, 1);
  }
  return null;
}

/**
 * Split "/remind" text into what and when: finds the longest trailing phrase that parses as
 * a time ("call mom in 20 minutes" → "call mom", +20 min). Leading "me to" is dropped.
 */
export function splitReminder(input: string, now: Date = new Date()): { text: string; when: Date } | null {
  const cleaned = input.trim().replace(/^me\s+(?:to\s+)?/i, "").replace(/^to\s+/i, "");
  const words = cleaned.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const when = parseWhen(words.slice(i).join(" "), now);
    if (when) {
      const text = words
        .slice(0, i)
        .join(" ")
        .replace(/\s+(?:on|at|by)$/i, "")
        .replace(/^["“](.*)["”]$/, "$1")
        .trim();
      if (text) return { text, when };
    }
  }
  // "/remind tomorrow 9am call mom" (time first).
  for (let i = words.length - 1; i >= 1; i--) {
    const when = parseWhen(words.slice(0, i).join(" "), now);
    if (when) {
      const text = words.slice(i).join(" ").replace(/^(?:to|that)\s+/i, "").trim();
      if (text) return { text, when };
    }
  }
  return null;
}

/** "30m", "1h", "2 hours", "until 5pm", "tomorrow" → when DND should end. */
export function parseDuration(input: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase().replace(/^for\s+/, "").replace(/^until\s+/, "");
  if (!s) return null;
  if (/^\d/.test(s) || /^an?\s/.test(s) || /^half/.test(s)) {
    const rel = parseWhen(`in ${s}`, now);
    if (rel) return rel;
  }
  return parseWhen(s, now);
}

/** "Tue 9:00 AM", "Today at 3:30 PM", "Tomorrow at 9:00 AM", "Mar 3 at 9:00 AM". */
export function describeWhen(d: Date, now: Date = new Date()): string {
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  if (d.toDateString() === addDays(now, 1).toDateString()) return `tomorrow at ${time}`;
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  if (days > 0 && days < 6.5) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })} at ${time}`;
}

/** Common presets used by "Remind me" and "Schedule for later". */
export function presetTimes(now: Date = new Date()) {
  const tomorrow9 = at(addDays(now, 1), { h: 9, m: 0 });
  const mondayDiff = ((1 - now.getDay() + 7) % 7) || 7;
  const nextMonday9 = at(addDays(now, mondayDiff), { h: 9, m: 0 });
  return { tomorrow9, nextMonday9 };
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
