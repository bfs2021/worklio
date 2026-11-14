"use client";

import { useSyncExternalStore } from "react";

/**
 * Unsent composer drafts, kept per channel (and per thread) in localStorage so
 * switching conversations or closing a thread doesn't throw away what you typed.
 */

const PREFIX = "worklio.draft.";
const listeners = new Set<() => void>();

export const draftKey = (channelId: string, parentId?: string | null) =>
  `${PREFIX}${channelId}${parentId ? `:${parentId}` : ""}`;

function read(key: string): string {
  try {
    return typeof window === "undefined" ? "" : (localStorage.getItem(key) ?? "");
  } catch {
    return "";
  }
}

function emit() {
  listeners.forEach((fn) => fn());
}

export const drafts = {
  get: (channelId: string, parentId?: string | null) => read(draftKey(channelId, parentId)),
  set(channelId: string, parentId: string | null | undefined, body: string) {
    const key = draftKey(channelId, parentId);
    const had = !!read(key);
    try {
      if (body.trim()) localStorage.setItem(key, body);
      else localStorage.removeItem(key);
    } catch {
      return;
    }
    // Only notify subscribers (sidebar indicators) when presence of a draft flips.
    if (had !== !!body.trim()) emit();
  },
  clear(channelId: string, parentId?: string | null) {
    drafts.set(channelId, parentId, "");
  },
};

/** Whether a channel has an unsent top-level draft. Re-renders when that changes. */
export function hasDraft(channelId: string): boolean {
  return !!read(draftKey(channelId)).trim();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(PREFIX)) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** React hook for sidebar rows: `const draft = useHasDraft(channel.id)`. */
export function useHasDraft(channelId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasDraft(channelId),
    () => false,
  );
}
