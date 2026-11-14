"use client";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import { joinNames } from "./call-styles";

/**
 * Overlapping avatar stack for call UI: consistent square-ish avatars, a ring in the colour of
 * the surface behind them (so overlaps read as cut-outs), and a "+N" chip. Never clips: every
 * item is shrink-0 and the stack sizes itself.
 */
const SIZE = {
  // UserAvatar base size + overrides on its inner face (first child span).
  sm: { base: "sm", radius: "rounded-[6px]", face: "[&>span]:size-5 [&>span]:rounded-[6px] [&>span]:text-[9.5px]", chip: "h-5 min-w-5 rounded-[6px] text-[9.5px]", overlap: "-ml-1.5" },
  md: { base: "md", radius: "rounded-[7px]", face: "[&>span]:size-6 [&>span]:rounded-[7px] [&>span]:text-[10px]", chip: "h-6 min-w-6 rounded-[7px] text-[10px]", overlap: "-ml-2" },
  lg: { base: "md", radius: "rounded-[8px]", face: "[&>span]:size-7 [&>span]:rounded-[8px] [&>span]:text-[11px]", chip: "h-7 min-w-7 rounded-[8px] text-[11px]", overlap: "-ml-2.5" },
} as const;

export function CallAvatarStack({
  ids,
  max = 4,
  size = "md",
  ringClassName = "ring-card",
  className,
  label,
}: {
  ids: string[];
  max?: number;
  size?: keyof typeof SIZE;
  /** Ring colour matching the surface, e.g. "ring-card", "ring-background", "ring-popover". */
  ringClassName?: string;
  className?: string;
  /** Accessible label; defaults to the people's names. */
  label?: string;
}) {
  const { memberById, me } = useWorkspace();
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  // With overflow, keep room for the chip inside `max` slots.
  const shown = unique.length > max ? unique.slice(0, Math.max(1, max - 1)) : unique;
  const extra = unique.length - shown.length;
  const nameOf = (id: string) => (id === me?.id ? "You" : (memberById[id]?.full_name ?? "Someone"));
  const names = unique.map(nameOf);
  const s = SIZE[size];

  return (
    <span
      role="img"
      aria-label={label ?? joinNames(names)}
      title={names.join(", ")}
      className={cn("inline-flex shrink-0 items-center", className)}
    >
      {shown.map((id, i) => (
        <UserAvatar
          key={id}
          id={id}
          name={id === me?.id ? (me?.full_name ?? "You") : (memberById[id]?.full_name ?? "?")}
          size={s.base}
          className={cn("ring-2", s.radius, ringClassName, s.face, i > 0 && s.overlap)}
        />
      ))}
      {extra > 0 && (
        <span
          aria-hidden
          className={cn(
            "relative inline-flex shrink-0 items-center justify-center bg-muted px-1 font-semibold text-muted-foreground tabular-nums ring-2",
            ringClassName,
            s.chip,
            s.overlap,
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
