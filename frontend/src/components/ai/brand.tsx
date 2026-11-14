"use client";

import { PowerOff, Settings2, ShieldCheck, Sparkles, type LucideProps } from "lucide-react";
import Link from "next/link";

import { aiGateCopy, useAIGate, type AIErrorCode, type AIFeature, type AIGateReason } from "@/lib/ai";
import { cn } from "@/lib/utils";

import { closeAsk } from "./ai-store";

/**
 * Worklio AI visual language: a sparkle on a violet→indigo gradient, used everywhere AI
 * shows up (buttons, menus, panels, answers) so AI output is always recognisable.
 */

/** Gradient text (violet → indigo). */
export const AI_GRADIENT_TEXT =
  "bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-transparent dark:from-violet-300 dark:to-indigo-300";
/** Soft gradient surface for AI cards and callouts. */
export const AI_SURFACE =
  "bg-gradient-to-br from-violet-500/[0.07] via-transparent to-indigo-500/[0.07] dark:from-violet-400/[0.10] dark:to-indigo-400/[0.10]";
/** Thin gradient ring for AI containers. */
export const AI_RING = "ring-1 ring-violet-500/20 dark:ring-violet-300/20";

/** The ✨ sparkle in AI colours. */
export function AISparkle({ className, ...props }: LucideProps) {
  return <Sparkles aria-hidden className={cn("size-4 shrink-0 text-violet-600 dark:text-violet-300", className)} {...props} />;
}

/** Rounded gradient tile with a white sparkle: the AI "avatar". */
export function AIAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm shadow-violet-500/30",
        className,
      )}
    >
      <Sparkles className="size-[55%]" />
    </span>
  );
}

/** "✨ Worklio AI" label. */
export function AILabel({ className, children = "Worklio AI" }: { className?: string; children?: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px] font-bold", className)}>
      <AISparkle className="size-3.5" />
      <span className={AI_GRADIENT_TEXT}>{children}</span>
    </span>
  );
}

/** Blinking soft caret shown at the end of streaming text. */
export function StreamingCursor() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[3px] translate-y-[3px] animate-pulse rounded-full bg-gradient-to-b from-violet-500 to-indigo-500"
    />
  );
}

/** "Searching messages…" progress line with a shimmering sparkle. */
export function AIStatusLine({ text, className }: { text: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center gap-2 text-[13px] text-muted-foreground", className)}>
      <AISparkle className="size-3.5 animate-spin [animation-duration:2.4s]" />
      <span className="animate-pulse">{text}</span>
    </div>
  );
}

/** Skeleton lines while the first tokens arrive. */
export function AIThinking({ text = "Thinking…" }: { text?: string }) {
  return (
    <div className="space-y-2.5">
      <AIStatusLine text={text} />
      <div className="space-y-2" aria-hidden>
        <div className="h-3 w-11/12 animate-pulse rounded-full bg-gradient-to-r from-violet-500/15 to-indigo-500/10" />
        <div className="h-3 w-4/5 animate-pulse rounded-full bg-gradient-to-r from-violet-500/15 to-indigo-500/10 [animation-delay:150ms]" />
        <div className="h-3 w-3/5 animate-pulse rounded-full bg-gradient-to-r from-violet-500/15 to-indigo-500/10 [animation-delay:300ms]" />
      </div>
    </div>
  );
}

/** "AI can make mistakes" footer. */
export function AIDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-1 text-[11px] text-muted-foreground", className)}>
      <AISparkle className="size-3 text-muted-foreground" />
      Worklio AI can make mistakes. Check important info against the sources.
    </p>
  );
}

/** Map an AI error code to the gate it represents (null for ordinary errors). */
export function gateFromError(code: AIErrorCode | null | undefined): AIGateReason | null {
  if (code === "ai_not_configured") return "not_configured";
  if (code === "policy") return "policy";
  if (code === "feature_disabled") return "feature_off";
  return null;
}

/** "Set up Worklio AI" / "Open AI settings" link for admins. */
export function AISetupLink({
  href,
  label = "Set up Worklio AI",
  className,
  onNavigate,
}: {
  href: string;
  label?: string;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={() => {
        closeAsk();
        onNavigate?.();
      }}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 px-3 text-[13px] font-semibold text-white shadow-sm shadow-violet-500/25 outline-none hover:from-violet-500 hover:to-indigo-500 focus-visible:ring-3 focus-visible:ring-violet-500/40",
        className,
      )}
    >
      <Settings2 className="size-3.5" aria-hidden /> {label}
    </Link>
  );
}

/**
 * Shown wherever AI would be when it's unavailable to me: not set up (admins get a "Set up
 * Worklio AI" button, members are told to ask an admin), limited to admins by the use_ai
 * policy, or this `feature` switched off. `reason` overrides what the status says (e.g. from
 * an error the server just returned).
 */
export function AIDisabledState({
  className,
  compact,
  feature,
  reason: reasonProp,
  onNavigate,
}: {
  className?: string;
  compact?: boolean;
  feature?: AIFeature;
  reason?: AIGateReason | null;
  onNavigate?: () => void;
}) {
  const gate = useAIGate(feature);
  const reason: AIGateReason = reasonProp ?? gate.reason ?? "not_configured";
  const copy = aiGateCopy(reason, gate.canConfigure);
  const Icon = reason === "policy" ? ShieldCheck : reason === "feature_off" ? PowerOff : null;
  return (
    <div role="status" className={cn("rounded-xl text-sm", compact ? "p-3" : "p-4", AI_SURFACE, AI_RING, className)}>
      <div className="flex items-start gap-3">
        {!compact &&
          (Icon ? (
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-[18px]" />
            </span>
          ) : (
            <AIAvatar className="size-9 opacity-80 grayscale-[35%]" />
          ))}
        <div className="min-w-0 space-y-1.5">
          <p className="font-bold">{copy.title}</p>
          <p className="text-muted-foreground">{copy.body}</p>
          {reason === "not_configured" && !compact && (
            <p className="text-xs text-muted-foreground">
              Worklio AI only reads conversations each person can already access.
            </p>
          )}
          {copy.cta && (
            <div className="pt-1">
              <AISetupLink
                href={gate.settingsHref}
                label={reason === "not_configured" ? "Set up Worklio AI" : "Open AI settings"}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Error callout for a failed AI request. */
export function AIErrorNote({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[13px]", className)} role="alert">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="ml-2 font-semibold text-link hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}
