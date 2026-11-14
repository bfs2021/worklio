"use client";

import { Settings, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AI_FEATURES, aiModelLabel, prettyModel, providerName, useAIGate, type AIFeature, type AIProvider, type AIStatus } from "@/lib/ai";
import { cn } from "@/lib/utils";

import { closeAsk } from "./ai-store";
/** Brand dot per provider (decorative). */
const PROVIDER_DOT: Record<AIProvider, string> = {
  anthropic: "bg-[#d97757]",
  gemini: "bg-gradient-to-br from-sky-400 via-indigo-500 to-fuchsia-500",
  deepseek: "bg-[#4d6bfe]",
};

const FEATURE_LABEL: Record<AIFeature, string> = {
  ask: "Ask Worklio",
  summaries: "Summaries & catch-up",
  composer: "Writing help",
  translate: "Translation",
  tasks: "Tasks from threads",
  agent: "@worklio agent",
  captions_summary: "Call summaries",
};

/** Small "Claude Opus 5.5 · Anthropic" chip for the active provider + model. */
export function AIModelChip({ status, className }: { status: AIStatus | null; className?: string }) {
  const label = aiModelLabel(status);
  if (!status?.enabled || !label) return null;
  return (
    <span
      title={`Worklio AI is using ${label}`}
      className={cn(
        "inline-flex h-[18px] max-w-full min-w-0 items-center gap-1 rounded-full border bg-background/70 px-1.5 text-[10.5px] leading-none font-semibold text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.provider ? PROVIDER_DOT[status.provider] : "bg-violet-500")} />
      <span className="truncate">{label}</span>
    </span>
  );
}

const ICON_BUTTON =
  "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-violet-500/50 data-popup-open:bg-muted data-popup-open:text-foreground";

/**
 * ⚙️ "AI settings" for the Ask Worklio header. Admins jump to Settings → Worklio AI; everyone
 * else gets a popover saying which provider/model is active and that only admins can change it.
 */
export function AISettingsButton({ className }: { className?: string }) {
  const gate = useAIGate();
  const router = useRouter();

  if (gate.canConfigure) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="AI settings"
              onClick={() => {
                closeAsk();
                router.push(gate.settingsHref);
              }}
              className={cn(ICON_BUTTON, className)}
            />
          }
        >
          <Settings className="size-[18px]" aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom">AI settings</TooltipContent>
      </Tooltip>
    );
  }

  const s = gate.status;
  const off = s ? AI_FEATURES.filter((f) => !s.features[f]) : [];
  const state = gate.loading ? "Checking…" : !s?.enabled ? "Not set up" : !s.can_use ? "Admins only" : "On";
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger aria-label="AI settings" className={cn(ICON_BUTTON, className)} />}>
          <Settings className="size-[18px]" aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom">AI settings</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] gap-3 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-bold">Worklio AI settings</p>
          <p className="text-xs text-muted-foreground">How AI is set up in this workspace.</p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-semibold">{state}</dd>
          {s?.enabled && (
            <>
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="flex min-w-0 items-center gap-1.5 font-semibold">
                {s.provider && <span aria-hidden className={cn("size-2 shrink-0 rounded-full", PROVIDER_DOT[s.provider])} />}
                <span className="truncate">{providerName(s.provider) || "Default"}</span>
              </dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="truncate font-semibold" title={s.model}>
                {prettyModel(s.model) || "Default"}
              </dd>
            </>
          )}
          {s?.enabled && off.length > 0 && (
            <>
              <dt className="text-muted-foreground">Turned off</dt>
              <dd className="text-[12.5px]">{off.map((f) => FEATURE_LABEL[f]).join(", ")}</dd>
            </>
          )}
        </dl>
        <p className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          Only workspace admins can change the AI provider, model and features.
        </p>
      </PopoverContent>
    </Popover>
  );
}
