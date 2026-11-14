"use client";

import { useCallback, useSyncExternalStore } from "react";

// --- A shared 1 s clock (one interval no matter how many subscribers) ---
let now = 0;
let timer: number | undefined;
const clockListeners = new Set<() => void>();

function subscribeClock(fn: () => void) {
  clockListeners.add(fn);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      clockListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    clockListeners.delete(fn);
    if (!clockListeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const getClock = () => now;
const getServerClock = () => 0;

/** Current time in ms, ticking once a second. 0 during SSR / before the first tick. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClock, getServerClock);
}

/** "4:07" / "1:02:33" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// --- Desktop breakpoint (Tailwind `sm`) ---
const DESKTOP_QUERY = "(min-width: 640px)";

function subscribeDesktop(fn: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** Live result of a CSS media query (`server` while rendering on the server). */
export function useMediaQuery(query: string, server = false): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => server,
  );
}
/** Tailwind `lg` and up. */
export const LG_QUERY = "(min-width: 1024px)";
