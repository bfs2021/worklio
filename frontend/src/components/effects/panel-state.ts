"use client";

import { useSyncExternalStore } from "react";

/**
 * Open state of the Effects panel. Global so any button (call window controls, the camera
 * device menu, the sidebar dock) can open it, while exactly one host renders it.
 */
let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === open) return;
  open = next;
  listeners.forEach((fn) => fn());
}

export const openEffectsPanel = () => set(true);
export const closeEffectsPanel = () => set(false);
export const setEffectsPanelOpen = (next: boolean) => set(next);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const getOpen = () => open;
const getServerOpen = () => false;

export function useEffectsPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpen, getServerOpen);
}
