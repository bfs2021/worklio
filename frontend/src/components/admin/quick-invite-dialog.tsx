"use client";

import { ArrowRight, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWorkspace } from "@/components/workspace/provider";
import { useWorkspaceSettings, viewerCan, type InviteLink } from "@/lib/admin";

import { SkeletonBlock } from "./controls";
import { InviteLinkForm, InviteLinkRow } from "./invite-links";

/** "Invite people" from the workspace menu: create and copy an invite link (guests links for admins only). */
export function QuickInviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const { settings, loading } = useWorkspaceSettings(ws.workspaceId);
  const [created, setCreated] = useState<InviteLink | null>(null);
  const myRole = (ws.me && ws.memberById[ws.me.id]?.role) || "member";
  const allowed = viewerCan(settings, "invite_members", myRole);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setCreated(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle className="pr-8 text-lg font-black">Invite people to {ws.workspace?.name}</DialogTitle>
          <DialogDescription>Share a link. Anyone who opens it can create an account and join.</DialogDescription>
        </DialogHeader>
        <div className="px-5 py-4">
          {loading && !settings ? (
            <SkeletonBlock rows={2} />
          ) : !allowed ? (
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p>Only workspace admins can invite people here. Ask an admin to send an invite.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <InviteLinkForm compact allowGuests={ws.isAdmin} onCreated={setCreated} />
              {created && (
                <div className="rounded-lg border">
                  <p className="border-b px-4 py-2 text-xs font-bold text-muted-foreground">Your new link · copied to clipboard</p>
                  <ul>
                    <InviteLinkRow link={created} />
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        {ws.isAdmin && (
          <div className="flex justify-end border-t bg-muted/40 px-5 py-3">
            <Link
              href={`/w/${ws.workspaceId}/settings?tab=invitations`}
              onClick={() => {
                onOpenChange(false);
                ws.setSidebarOpen(false);
              }}
              className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline"
            >
              Manage invite links and add by email <ArrowRight className="size-3.5" />
            </Link>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
