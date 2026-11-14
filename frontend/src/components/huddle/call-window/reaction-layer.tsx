"use client";

import { useWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

import type { FloatingReaction } from "./signals";

const CSS = `
@keyframes wk-call-float {
  0%   { opacity: 0; transform: translate3d(0, 12px, 0) scale(.6); }
  12%  { opacity: 1; transform: translate3d(calc(var(--wk-drift) * .15), -8%, 0) scale(1.15); }
  22%  { transform: translate3d(calc(var(--wk-drift) * .25), -16%, 0) scale(1); }
  80%  { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--wk-drift), calc(var(--wk-rise) * -1), 0) scale(.95); }
}
.wk-call-float { animation: wk-call-float 3s cubic-bezier(.2,.7,.3,1) forwards; will-change: transform, opacity; }
@media (prefers-reduced-motion: reduce) { .wk-call-float { animation-name: none !important; } }
[data-reduce-motion] .wk-call-float { animation-name: none !important; }
`;

/**
 * Emoji reactions floating up over the stage. Purely decorative for pointer users; each new
 * reaction is also announced politely for screen readers.
 */
export function ReactionLayer({
  reactions,
  size = "lg",
  className,
}: {
  reactions: FloatingReaction[];
  size?: "sm" | "lg";
  className?: string;
}) {
  const { memberById, me } = useWorkspace();
  const last = reactions.at(-1);
  const lastName = last ? (last.identity === me?.id ? "You" : (memberById[last.identity]?.full_name ?? "Someone")) : "";
  return (
    <>
      <style href="wk-call-float" precedence="default">
        {CSS}
      </style>
      <div aria-hidden className={cn("pointer-events-none absolute inset-0 z-20 overflow-hidden", className)}>
        {reactions.map((r) => {
          const name = r.identity === me?.id ? "You" : (memberById[r.identity]?.full_name?.split(" ")[0] ?? "");
          return (
            <span
              key={r.id}
              className="wk-call-float absolute bottom-3 flex -translate-x-1/2 flex-col items-center gap-1"
              style={
                {
                  left: `${r.x * 100}%`,
                  "--wk-drift": `${r.drift}px`,
                  "--wk-rise": size === "lg" ? "min(60vh, 420px)" : "120px",
                } as React.CSSProperties
              }
            >
              <span className={cn("leading-none drop-shadow-[0_4px_12px_rgb(0_0_0/0.35)]", size === "lg" ? "text-5xl" : "text-3xl")}>
                {r.emoji}
              </span>
              {size === "lg" && name && (
                <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                  {name}
                </span>
              )}
            </span>
          );
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {last ? `${lastName} reacted ${last.emoji}` : ""}
      </span>
    </>
  );
}
