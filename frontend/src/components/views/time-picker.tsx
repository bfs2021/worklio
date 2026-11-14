"use client";

import { CalendarClock, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { timePresets, toLocalInput, type TimePreset } from "@/lib/productivity";

/**
 * Preset time menu ("In 20 minutes", "In 1 hour", "In 3 hours", "Tomorrow", "Next week", "Custom…")
 * used for due dates, reminders and scheduled sends. `onChange(null)` clears.
 */
export function TimePicker({
  title,
  value,
  onChange,
  triggerClassName,
  triggerLabel,
  children,
  allowClear = true,
  maxDays,
  align = "end",
}: {
  /** Menu heading, e.g. "Remind me" / "Due" / "Send at". */
  title: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  triggerClassName?: string;
  /** Accessible name for the trigger. */
  triggerLabel: string;
  children: React.ReactNode;
  allowClear?: boolean;
  /** Upper bound for custom times (e.g. 120 days for scheduled sends). */
  maxDays?: number;
  align?: "start" | "center" | "end";
}) {
  const [presets, setPresets] = useState<TimePreset[]>([]);
  const [custom, setCustom] = useState<{ value: string; min: string; max: string } | null>(null);
  const [customError, setCustomError] = useState("");

  const openCustom = () => {
    const now = new Date();
    const start = value ? new Date(value) : new Date(now.getTime() + 60 * 60_000);
    setCustomError("");
    setCustom({
      value: toLocalInput(start.getTime() > now.getTime() ? start : new Date(now.getTime() + 60 * 60_000)),
      min: toLocalInput(now),
      max: maxDays ? toLocalInput(new Date(now.getTime() + maxDays * 86_400_000)) : "",
    });
  };

  const saveCustom = () => {
    if (!custom) return;
    const d = new Date(custom.value);
    if (Number.isNaN(d.getTime())) return setCustomError("Pick a date and time.");
    const now = Date.now();
    if (d.getTime() <= now) return setCustomError("Pick a time in the future.");
    if (maxDays && d.getTime() > now + maxDays * 86_400_000) return setCustomError(`Pick a time within ${maxDays} days.`);
    onChange(d.toISOString());
    setCustom(null);
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && setPresets(timePresets(new Date()))}>
        <DropdownMenuTrigger className={triggerClassName} aria-label={triggerLabel} title={triggerLabel}>
          {children}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{title}</DropdownMenuLabel>
            {presets.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onChange(p.at.toISOString())}>
                <span className="flex-1">{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.hint}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={openCustom}>
              <CalendarClock /> Custom…
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {allowClear && value && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onChange(null)}>
                <X /> Clear
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!custom} onOpenChange={(o) => !o && setCustom(null)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              saveCustom();
            }}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>Choose a date and time in your local time zone.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="views-custom-time">Date and time</Label>
              <Input
                id="views-custom-time"
                type="datetime-local"
                value={custom?.value ?? ""}
                min={custom?.min}
                max={custom?.max || undefined}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustom((c) => (c ? { ...c, value: v } : c));
                }}
                aria-invalid={!!customError}
              />
              {customError && <p className="text-sm text-destructive">{customError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCustom(null)}>
                Cancel
              </Button>
              <Button type="submit" className="bg-send text-white hover:bg-send/90">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
