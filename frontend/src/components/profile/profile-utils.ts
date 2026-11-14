import { useSyncExternalStore } from "react";

import type { ProfileFields } from "@/lib/api";

// ---------------------------------------------------------------------------
// A shared, coarse clock. Snapshots are minute-bucketed numbers, so they're
// referentially stable between ticks (useSyncExternalStore requirement).
// ---------------------------------------------------------------------------

const TICK_MS = 30_000;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(fn: () => void) {
  clockListeners.add(fn);
  if (!clockTimer) clockTimer = setInterval(() => clockListeners.forEach((l) => l()), TICK_MS);
  return () => {
    clockListeners.delete(fn);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
const clockSnapshot = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;
const clockServerSnapshot = () => 0;

/** Current time (ms), refreshed every 30 s. Returns 0 during SSR/hydration: treat 0 as "unknown". */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, clockSnapshot, clockServerSnapshot);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type ActiveStatus = { emoji: string | null; text: string | null; expiresAt: string | null };

/** The status to display, or null when unset or already expired (now = 0 skips the expiry check). */
export function activeStatus(p: ProfileFields | null | undefined, now: number): ActiveStatus | null {
  if (!p) return null;
  const emoji = p.status_emoji || null;
  const text = p.status_text || null;
  if (!emoji && !text) return null;
  if (p.status_expires_at && now && new Date(p.status_expires_at).getTime() <= now) return null;
  return { emoji, text, expiresAt: p.status_expires_at ?? null };
}

export type ClearAfter = "never" | "30m" | "1h" | "4h" | "today" | "week" | "custom";

export const CLEAR_AFTER_OPTIONS: { value: ClearAfter; label: string }[] = [
  { value: "never", label: "Don't clear" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "custom", label: "Choose date and time" },
];

export const STATUS_PRESETS: { emoji: string; text: string; clearAfter: ClearAfter; hint: string }[] = [
  { emoji: "📅", text: "In a meeting", clearAfter: "1h", hint: "1 hour" },
  { emoji: "🚌", text: "Commuting", clearAfter: "30m", hint: "30 minutes" },
  { emoji: "🤒", text: "Out sick", clearAfter: "today", hint: "Today" },
  { emoji: "🌴", text: "Vacationing", clearAfter: "never", hint: "Don't clear" },
  { emoji: "🏡", text: "Working remotely", clearAfter: "today", hint: "Today" },
];

/** Resolve a "clear after" choice to an absolute Date (null = never). */
export function expiryFor(choice: ClearAfter, from: Date, custom?: string): Date | null {
  const t = from.getTime();
  switch (choice) {
    case "never":
      return null;
    case "30m":
      return new Date(t + 30 * 60_000);
    case "1h":
      return new Date(t + 60 * 60_000);
    case "4h":
      return new Date(t + 4 * 60 * 60_000);
    case "today": {
      const d = new Date(from);
      d.setHours(23, 59, 59, 0);
      return d;
    }
    case "week": {
      // End of Sunday (weeks start on Monday).
      const d = new Date(from);
      const daysToSunday = (7 - d.getDay()) % 7;
      d.setDate(d.getDate() + daysToSunday);
      d.setHours(23, 59, 59, 0);
      return d;
    }
    case "custom": {
      if (!custom) return null;
      const d = new Date(custom);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
}

/** "until 4:30 PM", "until tomorrow", "until Fri, Nov 21". */
export function describeExpiry(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ref = new Date(now || d.getTime());
  const sameDay = d.toDateString() === ref.toDateString();
  if (sameDay) return `until ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const tomorrow = new Date(ref);
  tomorrow.setDate(ref.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString())
    return `until tomorrow, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return `until ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let zonesCache: string[] | null = null;
export function allTimeZones(): string[] {
  if (zonesCache) return zonesCache;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    zonesCache = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zonesCache = [];
  }
  if (!zonesCache.includes("UTC")) zonesCache = ["UTC", ...zonesCache];
  return zonesCache;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "4:12 PM" in the given zone, or null if the zone is invalid / time unknown. */
export function timeIn(tz: string | null | undefined, now: number): string | null {
  if (!tz || !now) return null;
  try {
    return new Date(now).toLocaleTimeString([], { timeZone: tz, hour: "numeric", minute: "2-digit" });
  } catch {
    return null;
  }
}

/** Short zone name like "PST" or "GMT+5". */
export function zoneAbbr(tz: string, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(
      new Date(now || 0),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** Offset in minutes from UTC for the zone at `now`. */
function offsetMinutes(tz: string, now: number): number | null {
  try {
    const d = new Date(now);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return Math.round((asUTC - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return null;
  }
}

/** "3 hours ahead", "1.5 hours behind", or null when the same as the viewer. */
export function relativeOffset(tz: string, now: number): string | null {
  if (!now) return null;
  const theirs = offsetMinutes(tz, now);
  const mine = offsetMinutes(browserTimeZone(), now);
  if (theirs === null || mine === null || theirs === mine) return null;
  const diff = (theirs - mine) / 60;
  const abs = Math.abs(diff);
  const n = Number.isInteger(abs) ? String(abs) : abs.toFixed(1).replace(/\.0$/, "");
  return `${n} hour${abs === 1 ? "" : "s"} ${diff > 0 ? "ahead" : "behind"}`;
}

/** "America/New_York" -> "New York (America)". */
export function prettyZone(tz: string): string {
  const parts = tz.split("/");
  if (parts.length === 1) return tz.replace(/_/g, " ");
  const city = parts.at(-1)!.replace(/_/g, " ");
  return `${city} (${parts.slice(0, -1).join(" / ").replace(/_/g, " ")})`;
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Client-side check before upload; returns an error message or null. */
export function checkAvatarFile(file: File): string | null {
  if (!AVATAR_TYPES.includes(file.type)) return "Please choose a PNG, JPEG, WebP or GIF image.";
  if (file.size > AVATAR_MAX_BYTES) return "That image is larger than 5 MB.";
  return null;
}
