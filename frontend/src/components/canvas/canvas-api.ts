/** Shared fetch helpers (still used by the huddle call-notes editor). Canvas REST lives in `@/lib/canvas`. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
}
