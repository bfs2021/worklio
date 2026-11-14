"use client";

import { useOptionalWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { activeStatus, describeExpiry, useNow } from "./profile-utils";

/**
 * The member's current status emoji (with the status text as tooltip), for placing next to names.
 * Renders nothing when the user has no active status or outside a workspace.
 */
export function StatusEmoji({ userId, className }: { userId: string; className?: string }) {
  const ws = useOptionalWorkspace();
  const now = useNow();
  const profile = ws?.memberById[userId] ?? (ws?.me?.id === userId ? ws.me : null);
  const status = activeStatus(profile, now);
  if (!status) return null;
  const expiry = describeExpiry(status.expiresAt, now);
  const label = [status.text, expiry].filter(Boolean).join(" · ") || "Status";
  return (
    <span
      title={label}
      aria-label={`Status: ${label}`}
      role="img"
      className={cn("inline-flex shrink-0 cursor-default items-center text-[0.95em] leading-none", className)}
    >
      {status.emoji ?? "💬"}
    </span>
  );
}
