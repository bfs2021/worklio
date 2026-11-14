/** Cross-player coordination: only one voice/video message plays at a time, and the chosen speed sticks. */

import { useSyncExternalStore } from "react";

import { useOptionalWorkspace } from "@/components/workspace/provider";

import { PLAYBACK_RATES } from "./media";

let active: HTMLMediaElement | null = null;

/** Call from a media element's `play` event: pauses whatever else was playing. */
export function claimPlayback(el: HTMLMediaElement) {
  if (active && active !== el && !active.paused) active.pause();
  active = el;
}

/** Forget an element that is going away (so it isn't kept alive by this module). */
export function releasePlayback(el: HTMLMediaElement | null) {
  if (el && active === el) active = null;
}

// --- Playback speed, remembered per signed-in user on this device ---

const RATE_KEY = "worklio.voice.rate";
const rateListeners = new Set<() => void>();

function keyFor(userId: string | undefined) {
  return userId ? `${RATE_KEY}:${userId}` : RATE_KEY;
}

function valid(v: number): boolean {
  return (PLAYBACK_RATES as readonly number[]).includes(v);
}

export function savedRate(userId?: string): number {
  try {
    const own = localStorage.getItem(keyFor(userId));
    const raw = own ?? localStorage.getItem(RATE_KEY);
    const v = Number(raw);
    return raw != null && valid(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveRate(rate: number, userId?: string) {
  try {
    localStorage.setItem(keyFor(userId), String(rate));
  } catch {
    /* private mode etc.: the speed just won't stick */
  }
  rateListeners.forEach((fn) => fn());
}

function subscribeRate(fn: () => void) {
  rateListeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(RATE_KEY)) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    rateListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const serverRate = () => 1;

/**
 * The current user's preferred playback speed, shared live by every player (and other tabs).
 * Returns `[rate, cycle]`; `cycle()` moves to the next speed and remembers it.
 */
export function usePlaybackRate(): [number, () => number] {
  const userId = useOptionalWorkspace()?.me?.id;
  const rate = useSyncExternalStore(subscribeRate, () => savedRate(userId), serverRate);
  const cycle = () => {
    const r = nextRate(rate);
    saveRate(r, userId);
    return r;
  };
  return [rate, cycle];
}

export function nextRate(rate: number): number {
  const i = (PLAYBACK_RATES as readonly number[]).indexOf(rate);
  return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length];
}

export function rateLabel(rate: number): string {
  return `${rate}×`;
}

const scanning = new WeakMap<HTMLMediaElement, (() => void)[]>();

/**
 * Chrome writes MediaRecorder WebM files without a duration, so `duration` is Infinity
 * until the whole file is scanned. Seeking far past the end forces that scan; we then restore
 * the position and run `then`. Gives up after a few seconds so a seek is never lost.
 */
export function fixInfiniteDuration(el: HTMLMediaElement, then?: () => void) {
  if (el.duration !== Infinity) {
    then?.();
    return;
  }
  const pending = scanning.get(el);
  if (pending) {
    // A scan is already running: just queue the follow-up.
    if (then) pending.push(then);
    return;
  }
  const queue: (() => void)[] = then ? [then] : [];
  scanning.set(el, queue);
  const wasPaused = el.paused;
  let timer = 0;
  const onChange = () => {
    if (Number.isFinite(el.duration)) finish();
  };
  function finish() {
    window.clearTimeout(timer);
    el.removeEventListener("durationchange", onChange);
    scanning.delete(el);
    try {
      el.currentTime = 0;
    } catch {
      /* element gone */
    }
    if (!wasPaused && el.paused) void el.play().catch(() => undefined);
    queue.forEach((fn) => fn());
  }
  timer = window.setTimeout(finish, 4000);
  el.addEventListener("durationchange", onChange);
  try {
    el.currentTime = 1e101;
  } catch {
    finish();
  }
}

/** True while `fixInfiniteDuration` is scanning this element (its `ended` event is not real). */
export function isScanning(el: HTMLMediaElement): boolean {
  return scanning.has(el);
}
