"use client";

import { MonitorPlay } from "lucide-react";
import { useRef, useState } from "react";

import { colorForUser } from "@/components/annotate";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useOptionalWorkspace } from "@/components/workspace/provider";
import type { Message } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { canRecordClips, RecordingStudio } from "./studio";

/** Composer button: opens the recording studio (screen / screen + camera / camera) and sends the clip. */
export function RecordClipButton({
  workspaceId,
  channelId,
  parentId,
  onSent,
  className,
}: {
  workspaceId: string;
  channelId: string;
  parentId?: string;
  onSent?: (m: Message) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const busyRef = useRef(false);
  const me = useOptionalWorkspace()?.me ?? null;
  const user = me
    ? { id: me.id, name: me.full_name, color: colorForUser(me.id) }
    : { id: "me", name: "You", color: "#f43f5e" };

  const openStudio = () => {
    if (!canRecordClips()) {
      toast.error("Recording needs a browser with screen and camera recording support.");
      return;
    }
    busyRef.current = false;
    setOpen(true);
  };

  const onOpenChange = (next: boolean) => {
    if (next) return;
    if (busyRef.current && !window.confirm("Discard this recording?")) return;
    busyRef.current = false;
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={openStudio}
        aria-label="Record screen or video"
        title="Record screen or video"
        className={cn("rounded p-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:p-1.5", className)}
      >
        <MonitorPlay className="size-[18px]" />
      </button>
      <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
        <DialogContent
          showCloseButton={false}
          className="dark gap-0 overflow-hidden border border-white/10 bg-zinc-950/95 p-0 text-zinc-100 shadow-2xl ring-white/10 backdrop-blur-xl sm:max-w-3xl"
        >
          <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400 ring-1 ring-red-500/20">
              <MonitorPlay className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-bold text-white">Record a clip</DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                Screen, camera or both · up to 15 minutes · draw on it while you talk. Sent only when you choose Send.
              </DialogDescription>
            </div>
          </div>
          {open && (
            <RecordingStudio
              workspaceId={workspaceId}
              channelId={channelId}
              parentId={parentId}
              user={user}
              busyRef={busyRef}
              onSent={onSent}
              onClose={() => {
                busyRef.current = false;
                setOpen(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
