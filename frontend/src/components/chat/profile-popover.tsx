"use client";

import { Clock, Mail, MessageCircle, Pencil, Phone } from "lucide-react";
import { useState } from "react";

import { activeStatus, describeExpiry, relativeOffset, timeIn, useNow } from "@/components/profile/profile-utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWorkspace } from "@/components/workspace/provider";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { UserAvatar } from "./user-avatar";

/** Click a name/avatar to see a profile card, like a desktop chat app. */
export function ProfilePopover({
  userId,
  children,
  className,
}: {
  userId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={cn("cursor-pointer text-left", className)}>{children}</PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0" align="start">
        {open && <ProfileCard userId={userId} onClose={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

function ProfileCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const ws = useWorkspace();
  const now = useNow();
  const m = ws.memberById[userId];
  const isMe = userId === ws.me?.id;
  const profile = m ?? (isMe ? ws.me : null);
  const name = m?.full_name ?? (isMe ? ws.me?.full_name : undefined) ?? "Unknown user";
  const isOnline = ws.online.has(userId);
  const status = activeStatus(profile, now);
  const tz = profile?.timezone ?? null;
  const local = timeIn(tz, now);
  const offset = tz ? relativeOffset(tz, now) : null;
  const email = m?.email ?? (isMe ? ws.me?.email : null);
  const phone = profile?.phone ?? null;

  const message = async () => {
    try {
      await ws.openDM([userId]);
      onClose();
    } catch (err) {
      toast.error(`Couldn't open conversation: ${errorMessage(err)}`);
    }
  };

  return (
    <>
      <div className="h-14" style={{ backgroundImage: "var(--chrome-gradient)" }} aria-hidden />
      <div className="-mt-9 px-4">
        <UserAvatar id={userId} name={name} size="xl" className="rounded-xl ring-4 ring-popover" />
      </div>

      <div className="space-y-1 px-4 pt-2 pb-3">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-lg font-black break-words">{name}</span>
          {profile?.pronouns && <span className="text-sm text-muted-foreground">{profile.pronouns}</span>}
          {isMe && <span className="text-sm text-muted-foreground">(you)</span>}
        </div>
        {profile?.title && <div className="text-sm break-words">{profile.title}</div>}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className={cn("size-2 rounded-full", isOnline ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          {isOnline ? "Active" : "Away"}
          {m && m.role !== "member" && <span className="rounded bg-muted px-1.5 text-xs capitalize">{m.role}</span>}
        </div>
        {status && (
          <div className="mt-2 flex items-start gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-sm">
            <span className="text-base leading-5" aria-hidden>
              {status.emoji ?? "💬"}
            </span>
            <span className="min-w-0">
              <span className="block break-words">{status.text || "Status set"}</span>
              {status.expiresAt && (
                <span className="block text-xs text-muted-foreground">{describeExpiry(status.expiresAt, now)}</span>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t px-4 py-3 text-sm">
        {local && (
          <div className="flex items-center gap-2">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">{local}</span> local time
              {offset && <span className="text-muted-foreground"> · {offset}</span>}
            </span>
          </div>
        )}
        {email && (
          <a href={`mailto:${email}`} className="flex min-w-0 items-center gap-2 text-link hover:underline">
            <Mail className="size-4 shrink-0" /> <span className="truncate">{email}</span>
          </a>
        )}
        {phone && (
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="flex min-w-0 items-center gap-2 text-link hover:underline">
            <Phone className="size-4 shrink-0" /> <span className="truncate">{phone}</span>
          </a>
        )}
      </div>

      {(m || isMe) && (
      <div className="flex gap-2 border-t p-3">
        {m && (
          <Button className="flex-1" variant="outline" onClick={message}>
            <MessageCircle className="size-4" /> Message
          </Button>
        )}
        {isMe && (
          <Button
            className="flex-1"
            variant="outline"
            onClick={() => {
              onClose();
              ws.setSidebarOpen(false);
              ws.setProfileOpen(true);
            }}
          >
            <Pencil className="size-4" /> Edit profile
          </Button>
        )}
      </div>
      )}
    </>
  );
}
