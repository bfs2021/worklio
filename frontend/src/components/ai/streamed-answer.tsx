"use client";

import { Check, Copy, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { useWorkspace } from "@/components/workspace/provider";
import { isGateError, type AICitation, type AIFeature } from "@/lib/ai";
import { copyText } from "@/lib/clipboard";
import { decodeMentions } from "@/lib/format";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { AIMarkdown } from "./ai-markdown";
import { AIDisabledState, AIDisclaimer, AIErrorNote, AIThinking, gateFromError } from "./brand";
import { CitationList, useJumpToCitation } from "./citations";
import { useAIStream, type AIStreamState } from "./use-ai-stream";

/** Plain text for the clipboard: names instead of mention tokens, no citation markers. */
export function useAICopy() {
  const { memberById } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    const plain = decodeMentions(text, memberById).replace(/\s?\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g, "");
    copyText(plain)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch((err) => toast.error(errorMessage(err, "Couldn't copy to clipboard")));
  };
  return { copied, copy };
}

export function ActionButton({
  onClick,
  children,
  disabled,
  primary,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        primary
          ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-sm shadow-violet-500/25 hover:from-violet-500 hover:to-indigo-500"
          : "border bg-background hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Self-starting streamed AI answer (summaries, catch-up): status line, streaming markdown with
 * citation chips, sources, errors, Stop / Copy / Regenerate and caller-provided actions.
 * Remount (change `key`) to start a different request.
 */
export function StreamedAnswer({
  path,
  body,
  thinking = "Reading the conversation…",
  empty = "Nothing to summarize here yet.",
  actions,
  onJump,
  linkChannels,
  feature,
  className,
}: {
  path: string;
  body: unknown;
  thinking?: string;
  empty?: string;
  actions?: (s: AIStreamState) => React.ReactNode;
  onJump?: () => void;
  linkChannels?: boolean;
  /** The AI feature this answer belongs to, for the disabled state's copy. */
  feature?: AIFeature;
  className?: string;
}) {
  const s = useAIStream(true);
  const { run, stop } = s;
  const [nonce, setNonce] = useState(0);
  const jump = useJumpToCitation(onJump);
  const { copied, copy } = useAICopy();
  const bodyKey = JSON.stringify(body ?? {});

  useEffect(() => {
    void run(path, JSON.parse(bodyKey));
  }, [run, path, bodyKey, nonce]);

  const regenerate = () => {
    s.reset(true);
    setNonce((n) => n + 1);
  };

  if (isGateError(s.error?.code)) return <AIDisabledState feature={feature} reason={gateFromError(s.error?.code)} className={className} />;

  const waiting = s.streaming && !s.text;
  return (
    <div className={cn("space-y-3", className)}>
      {waiting && <AIThinking text={s.status ?? thinking} />}
      {s.text && (
        <>
          {s.streaming && s.status && <AIStatusInline text={s.status} />}
          <AIMarkdown text={s.text} citations={s.citations} streaming={s.streaming} onCite={jump} linkChannels={linkChannels} />
        </>
      )}
      {!s.streaming && !s.text && !s.error && s.finished && !s.stopped && (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
      {s.error && <AIErrorNote message={s.error.message} onRetry={s.error.code === "refusal" ? undefined : regenerate} />}
      {s.stopped && <p className="text-xs text-muted-foreground italic">Stopped.</p>}
      {!s.streaming && s.citations.length > 0 && <CitationList citations={s.citations} onJump={jump} />}

      <div className="flex flex-wrap items-center gap-1.5">
        {s.streaming ? (
          <ActionButton onClick={stop}>
            <Square className="size-3.5 fill-current" /> Stop
          </ActionButton>
        ) : (
          <>
            {actions?.(s)}
            {s.text && (
              <ActionButton onClick={() => copy(s.text)}>
                {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </ActionButton>
            )}
            <ActionButton onClick={regenerate} title="Generate again">
              <RotateCcw className="size-3.5" /> Regenerate
            </ActionButton>
          </>
        )}
      </div>
      {(s.text || s.finished) && <AIDisclaimer />}
    </div>
  );
}

function AIStatusInline({ text }: { text: string }) {
  return <p className="animate-pulse text-xs text-muted-foreground">{text}</p>;
}

export type { AICitation };
