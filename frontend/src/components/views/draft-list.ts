"use client";

import { useMemo, useSyncExternalStore } from "react";

import { draftKey, drafts } from "@/lib/drafts";

/** Every unsent composer draft in this browser (lib/drafts.ts stores them in localStorage). */
export type DraftEntry = { key: string; channelId: string; parentId: string | null; body: string };

const PREFIX = draftKey("");
const listeners = new Set<() => void>();

/** Serialized snapshot: a string is stable by value, so useSyncExternalStore never loops. */
function snapshot(): string {
  try {
    const out: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const v = localStorage.getItem(k);
      if (v?.trim()) out.push([k, v]);
    }
    out.sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify(out);
  } catch {
    return "[]";
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(PREFIX)) fn();
  };
  const onFocus = () => fn();
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
}

function parse(raw: string): DraftEntry[] {
  try {
    return (JSON.parse(raw) as [string, string][]).map(([key, body]) => {
      const rest = key.slice(PREFIX.length);
      const [channelId, parentId] = rest.split(":");
      return { key, channelId, parentId: parentId || null, body };
    });
  } catch {
    return [];
  }
}

export function useDraftList(): DraftEntry[] {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "[]");
  return useMemo(() => parse(raw), [raw]);
}

export function deleteDraft(d: Pick<DraftEntry, "channelId" | "parentId">) {
  drafts.clear(d.channelId, d.parentId);
  listeners.forEach((fn) => fn());
}
