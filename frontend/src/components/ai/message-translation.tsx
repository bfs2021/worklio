"use client";

import { ChevronDown, Languages, Settings2, X } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { useGroupsById } from "@/components/messaging/use-groups";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspace } from "@/components/workspace/provider";
import { languageName, useAIGate } from "@/lib/ai";
import type { Message } from "@/lib/api";
import { formatMessage } from "@/lib/format";
import { cn } from "@/lib/utils";

import {
  LANGUAGES,
  clearTranslation,
  closeTranslateDialog,
  preferredLanguage,
  registerTranslationSlot,
  setTranslationHidden,
  translateMessage,
  useAIUI,
  type Translation,
} from "./ai-store";
import { AISparkle, AI_GRADIENT_TEXT } from "./brand";

/** Language switcher used by the inline translation and the dialog. */
export function LanguagePicker({
  value,
  onPick,
  className,
}: {
  value: string;
  onPick: (lang: string) => void;
  className?: string;
}) {
  const mine = preferredLanguage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground",
          className,
        )}
        aria-label="Change translation language"
      >
        <Languages className="size-3.5" /> {languageName(value)} <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Translate to</DropdownMenuLabel>
          {!LANGUAGES.some((l) => l === mine) && (
            <DropdownMenuItem onClick={() => onPick(mine)}>
              {mine} <span className="ml-auto text-[11px] text-muted-foreground">Your language</span>
            </DropdownMenuItem>
          )}
          {LANGUAGES.map((l) => (
            <DropdownMenuItem key={l} onClick={() => onPick(l)}>
              {l}
              {l === mine && <span className="ml-auto text-[11px] text-muted-foreground">Your language</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TranslationBody({ messageId, t, inDialog }: { messageId: string; t: Translation; inDialog?: boolean }) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const gate = useAIGate("translate");
  const detected = t.detected ? languageName(t.detected) : null;

  if (t.status === "loading")
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
        <AISparkle className="size-3.5 animate-spin [animation-duration:2.4s]" />
        <span className="animate-pulse">Translating to {languageName(t.lang)}…</span>
      </div>
    );

  if (t.status === "error")
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
        <span className="text-muted-foreground">{t.error}</span>
        {t.gate ? (
          gate.canConfigure &&
          t.gate !== "policy" && (
            <Link
              href={gate.settingsHref}
              onClick={() => closeTranslateDialog()}
              className="inline-flex items-center gap-1 font-semibold text-link hover:underline"
            >
              <Settings2 className="size-3.5" aria-hidden /> {t.gate === "not_configured" ? "Set up Worklio AI" : "Open AI settings"}
            </Link>
          )
        ) : (
          <button onClick={() => translateMessage(messageId, t.lang)} className="font-semibold text-link hover:underline">
            Try again
          </button>
        )}
        {!inDialog && (
          <button onClick={() => clearTranslation(messageId)} className="font-semibold text-muted-foreground hover:underline">
            Dismiss
          </button>
        )}
      </div>
    );

  return (
    <div className="space-y-1">
      <div className="text-msg break-words whitespace-pre-wrap">
        {formatMessage(t.text, { names: ws.memberById, meId: ws.me?.id, groups })}
      </div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <AISparkle className="size-3" />
          <span className={cn("font-semibold", AI_GRADIENT_TEXT)}>Translated</span>
          {detected && <span>from {detected}</span>}
        </span>
        <span aria-hidden>·</span>
        <LanguagePicker value={t.lang} onPick={(l) => translateMessage(messageId, l)} />
        {!inDialog && (
          <>
            <span aria-hidden>·</span>
            <button onClick={() => setTranslationHidden(messageId, true)} className="rounded px-1 font-semibold hover:text-foreground hover:underline">
              Show original
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Inline translation under a message. Mount it in MessageItem right below the body:
 *   <MessageTranslation messageId={m.id} />
 * Renders nothing until the reader picks "Translate" from the message's actions menu.
 */
export function MessageTranslation({ messageId, className }: { messageId: string; className?: string }) {
  const t = useAIUI((s) => s.translations[messageId]);
  useEffect(() => registerTranslationSlot(messageId), [messageId]);
  if (!t) return null;

  if (t.hidden)
    return (
      <button
        onClick={() => setTranslationHidden(messageId, false)}
        className={cn("mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground", className)}
      >
        <AISparkle className="size-3" /> Show translation ({languageName(t.lang)})
      </button>
    );

  return (
    <div
      className={cn(
        "relative mt-1 rounded-r-lg border-l-2 border-violet-500/60 bg-violet-500/[0.05] py-1.5 pr-8 pl-3 dark:border-violet-300/50 dark:bg-violet-400/[0.07]",
        className,
      )}
    >
      <TranslationBody messageId={messageId} t={t} />
      <button
        onClick={() => clearTranslation(messageId)}
        className="absolute top-1 right-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Close translation"
        title="Close translation"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Fallback when the message isn't rendered with an inline slot (e.g. search results). */
export function TranslateDialog({ message }: { message: Message }) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const t = useAIUI((s) => s.translations[message.id]);
  const author = ws.memberById[message.author_id]?.full_name ?? "Someone";
  return (
    <Dialog open onOpenChange={(o) => !o && closeTranslateDialog()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AISparkle /> Translate message
          </DialogTitle>
          <DialogDescription>Message from {author}</DialogDescription>
        </DialogHeader>
        <div className="max-h-40 overflow-y-auto rounded-lg border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {formatMessage(message.body, { names: ws.memberById, meId: ws.me?.id, groups })}
        </div>
        {t ? (
          <div className="rounded-lg border-l-2 border-violet-500/60 bg-violet-500/[0.05] px-3 py-2">
            <TranslationBody messageId={message.id} t={t} inDialog />
          </div>
        ) : (
          <LanguagePicker value={preferredLanguage()} onPick={(l) => translateMessage(message.id, l)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
