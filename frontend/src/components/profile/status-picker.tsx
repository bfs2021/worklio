"use client";

import { SmilePlus, X } from "lucide-react";
import { useState } from "react";

import { EmojiPicker } from "@/components/chat/emoji-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspace } from "@/components/workspace/provider";
import { api, type User } from "@/lib/api";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import {
  activeStatus,
  CLEAR_AFTER_OPTIONS,
  type ClearAfter,
  describeExpiry,
  expiryFor,
  STATUS_PRESETS,
  useNow,
} from "./profile-utils";

const MAX_TEXT = 100;

/** Value for <input type="datetime-local"> in the viewer's local zone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * "Set a status" dialog: presets, custom emoji + text, and when to clear it.
 * Self-contained; mount it anywhere inside <WorkspaceProvider>.
 */
export function StatusPickerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <div className="border-b px-5 pt-5 pb-3">
          <DialogTitle className="text-lg font-black">Set a status</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Let people know what you&apos;re up to.
          </DialogDescription>
        </div>
        {open && ws.me && <StatusPicker me={ws.me} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** The picker body. `onDone` is called after a successful save/clear or on cancel. */
export function StatusPicker({ me, onDone }: { me: User; onDone: () => void }) {
  const ws = useWorkspace();
  const now = useNow();
  const current = activeStatus(me, now);
  const [emoji, setEmoji] = useState<string | null>(current?.emoji ?? null);
  const [text, setText] = useState(current?.text ?? "");
  const [clearAfter, setClearAfter] = useState<ClearAfter>(
    current ? (current.expiresAt ? "custom" : "never") : "today",
  );
  const [custom, setCustom] = useState(current?.expiresAt ? toLocalInput(new Date(current.expiresAt)) : "");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasStatus = !!(emoji || text.trim());

  const applyPreset = (p: (typeof STATUS_PRESETS)[number]) => {
    setEmoji(p.emoji);
    setText(p.text);
    setClearAfter(p.clearAfter);
  };

  const finish = async (updated: User, msg: string) => {
    ws.setMe(updated);
    ws.reloadMembers().catch(() => {});
    toast.success(msg);
    onDone();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasStatus) return;
    const expires = expiryFor(clearAfter, new Date(), custom);
    if (clearAfter === "custom" && (!expires || expires.getTime() <= Date.now())) {
      toast.error("Pick a date and time in the future.");
      return;
    }
    setSaving(true);
    try {
      const updated = await api<User>("/auth/me/status", {
        method: "PUT",
        body: JSON.stringify({
          emoji: emoji || (text.trim() ? "💬" : null),
          text: text.trim() || null,
          expires_at: expires ? expires.toISOString() : null,
        }),
      });
      await finish(updated, "Status updated");
    } catch (err) {
      toast.error(`Couldn't set status: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      const updated = await api<User>("/auth/me/status", { method: "DELETE" });
      await finish(updated, "Status cleared");
    } catch (err) {
      toast.error(`Couldn't clear status: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const previewExpiry = now ? describeExpiry(expiryFor(clearAfter, new Date(now), custom)?.toISOString() ?? null, now) : null;

  return (
    <form onSubmit={save} className="flex flex-col">
      <div className="space-y-5 p-5">
        {/* Emoji + text */}
        <div>
          <Label htmlFor="status-text" className="sr-only">
            Status text
          </Label>
          <div className="flex items-center gap-1 rounded-lg border border-input bg-transparent pr-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger
                type="button"
                aria-label={emoji ? `Status emoji ${emoji}, change` : "Choose a status emoji"}
                className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {emoji ?? <SmilePlus className="size-5 text-muted-foreground" />}
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <EmojiPicker
                  onPick={(e) => {
                    setEmoji(e);
                    setEmojiOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            <input
              id="status-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
              placeholder="What's your status?"
              maxLength={MAX_TEXT}
              autoComplete="off"
              className="h-10 min-w-0 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
            />
            {hasStatus && (
              <button
                type="button"
                onClick={() => {
                  setEmoji(null);
                  setText("");
                }}
                aria-label="Clear status text and emoji"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <div className="mt-1 text-right text-[11px] text-muted-foreground tabular-nums">
            {text.length}/{MAX_TEXT}
          </div>
        </div>

        {/* Presets */}
        <div>
          <div className="mb-1.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">Suggestions</div>
          <ul className="-mx-2 space-y-0.5">
            {STATUS_PRESETS.map((p) => {
              const active = emoji === p.emoji && text === p.text;
              return (
                <li key={p.text}>
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    aria-pressed={active}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                      active && "bg-muted",
                    )}
                  >
                    <span className="w-6 text-center text-lg leading-none" aria-hidden>
                      {p.emoji}
                    </span>
                    <span className="font-medium">{p.text}</span>
                    <span className="text-muted-foreground">· {p.hint}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Clear after */}
        <div className="space-y-2">
          <Label htmlFor="status-clear">Clear after</Label>
          <select
            id="status-clear"
            value={clearAfter}
            onChange={(e) => {
              const v = e.target.value as ClearAfter;
              setClearAfter(v);
              if (v === "custom" && !custom) setCustom(toLocalInput(new Date(Date.now() + 60 * 60_000)));
            }}
            className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          >
            {CLEAR_AFTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {clearAfter === "custom" && (
            <>
              <Label htmlFor="status-custom" className="sr-only">
                Clear at
              </Label>
              <input
                id="status-custom"
                type="datetime-local"
                value={custom}
                min={now ? toLocalInput(new Date(now)) : undefined}
                onChange={(e) => setCustom(e.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              />
            </>
          )}
          {hasStatus && previewExpiry && <p className="text-xs text-muted-foreground">Clears {previewExpiry}.</p>}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        {current ? (
          <Button type="button" variant="ghost" onClick={clear} disabled={saving} className="text-destructive">
            Clear status
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2 sm:justify-end">
          <Button type="button" variant="outline" onClick={onDone} disabled={saving} className="flex-1 sm:flex-none">
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!hasStatus || saving}
            className="flex-1 bg-send text-white hover:bg-send/90 sm:flex-none"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}
