"use client";

import { Loader2 } from "lucide-react";

import type { ConnectionStatus } from "@/lib/api";

/**
 * Slim amber bar shown while the realtime socket is down after having connected once.
 * Render it at the top of the main column with the status from `useRealtime`.
 */
export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status !== "reconnecting") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-4 py-1 text-xs font-bold text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
    >
      <Loader2 className="size-3.5 animate-spin" />
      Reconnecting… new messages will appear once you&apos;re back online.
    </div>
  );
}
