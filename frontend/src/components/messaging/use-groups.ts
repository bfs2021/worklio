"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { messaging, type UserGroup } from "@/lib/messaging";

/**
 * Workspace user groups (@design, @oncall…), shared by every composer and message.
 * One fetch per workspace; `refreshGroups()` after creating/editing a group.
 */

const EMPTY: UserGroup[] = [];
const cache = new Map<string, UserGroup[]>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

function load(workspaceId: string) {
  if (inFlight.has(workspaceId)) return;
  inFlight.add(workspaceId);
  messaging
    .groups(workspaceId)
    .then((groups) => cache.set(workspaceId, groups))
    // Groups are an enhancement: without them mentions still work for people.
    .catch(() => cache.set(workspaceId, cache.get(workspaceId) ?? EMPTY))
    .finally(() => {
      inFlight.delete(workspaceId);
      emit();
    });
}

/** Ids of the groups `userId` belongs to (from the cache; empty until groups have loaded). */
export function groupIdsFor(workspaceId: string, userId: string | undefined): string[] {
  if (!userId) return [];
  return (cache.get(workspaceId) ?? EMPTY).filter((g) => g.member_ids.includes(userId)).map((g) => g.id);
}

export function refreshGroups(workspaceId: string) {
  load(workspaceId);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function useUserGroups(workspaceId: string | undefined): UserGroup[] {
  const groups = useSyncExternalStore(
    subscribe,
    () => (workspaceId ? (cache.get(workspaceId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (workspaceId && !cache.has(workspaceId)) load(workspaceId);
  }, [workspaceId]);
  return groups;
}

/** Groups keyed by id, for rendering `<!subteam^ID>` chips. */
export function useGroupsById(workspaceId: string | undefined): Record<string, UserGroup> {
  const groups = useUserGroups(workspaceId);
  return useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g])), [groups]);
}

/** True once the workspace's groups have been fetched (or the fetch failed). */
export function useGroupsLoaded(workspaceId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (workspaceId ? cache.has(workspaceId) : false),
    () => false,
  );
}
