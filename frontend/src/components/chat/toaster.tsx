"use client";

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useSyncExternalStore } from "react";

import { dismissToast, toastStore } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICONS = { error: CircleAlert, success: CircleCheck, info: Info } as const;

/** Renders toasts from lib/toast. Mount exactly once (workspace shell). */
export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getServerSnapshot);

  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-sm animate-in items-center gap-2.5 rounded-lg border bg-popover py-2 pr-2 pl-3 text-sm text-popover-foreground shadow-lg fade-in-0 slide-in-from-bottom-2"
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                t.kind === "error" ? "text-destructive" : t.kind === "success" ? "text-emerald-600" : "text-link",
              )}
            />
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
