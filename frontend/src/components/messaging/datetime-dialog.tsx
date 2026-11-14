"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { useNow } from "@/components/profile/profile-utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { describeWhen, parseWhen, toLocalInput } from "./natural-time";

/**
 * Pick a future date/time: a natural-language field ("tomorrow 3pm") plus a native
 * date-time input. `onPick` may be async; returning false keeps the dialog open.
 */
export function DateTimeDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  initial,
  maxDays,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  initial?: Date;
  /** Upper bound in days from now (scheduled send allows 120). */
  maxDays?: number;
  onPick: (when: Date) => boolean | void | Promise<boolean | void>;
}) {
  const [value, setValue] = useState(() => toLocalInput(initial ?? defaultTime()));
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  const now = useNow();
  const when = value ? new Date(value) : null;
  const tooLate = !!when && !!maxDays && !!now && when.getTime() - now > maxDays * 86_400_000;
  const past = !!when && !!now && when.getTime() <= now;
  const valid = !!when && !Number.isNaN(when.getTime()) && !past && !tooLate;
  const parsed = phrase.trim() ? parseWhen(phrase) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !when || busy) return;
    if (when.getTime() <= Date.now()) return;
    setBusy(true);
    try {
      const ok = await onPick(when);
      if (ok !== false) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-lg font-black">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="dt-phrase" className="text-sm font-bold">
              When
            </label>
            <Input
              id="dt-phrase"
              value={phrase}
              placeholder="e.g. tomorrow 3pm, in 2 hours, next monday"
              onChange={(e) => {
                setPhrase(e.target.value);
                const d = parseWhen(e.target.value);
                if (d) setValue(toLocalInput(d));
              }}
            />
            {phrase.trim() && (
              <p className={parsed ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                {parsed ? describeWhen(parsed) : "Couldn't understand that time — pick one below."}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="dt-exact" className="text-sm font-bold">
              Date and time
            </label>
            <Input id="dt-exact" type="datetime-local" value={value} min={now ? toLocalInput(new Date(now)) : undefined} onChange={(e) => setValue(e.target.value)} />
            {past && <p className="text-xs text-destructive">Pick a time in the future.</p>}
            {tooLate && <p className="text-xs text-destructive">That&apos;s too far ahead (max {maxDays} days).</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy} className="bg-send text-white hover:bg-send/90">
              {busy && <Loader2 className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function defaultTime() {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}
