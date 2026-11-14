"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/toast";

/**
 * Themed replacement for `window.confirm`. `onConfirm` may be async: the dialog stays
 * open with a spinner while it runs, closes on success and shows the error on failure.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** Optional preview (e.g. the message being deleted). */
  children?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) setError("");
        onOpenChange(o);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onKeyDown={(e) => {
          // Enter confirms, unless focus is on Cancel (Enter then activates Cancel natively).
          if (e.key === "Enter" && !(e.target as HTMLElement).closest("[data-confirm-cancel]")) {
            e.preventDefault();
            confirm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-black">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children && (
          <div className="max-h-48 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-msg break-words whitespace-pre-wrap">
            {children}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" data-confirm-cancel autoFocus disabled={busy} />}>Cancel</DialogClose>
          <Button
            onClick={confirm}
            disabled={busy}
            className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : "bg-send text-white hover:bg-send/90"}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
