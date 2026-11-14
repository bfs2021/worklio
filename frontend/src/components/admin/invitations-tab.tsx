"use client";

import { Link2, Mail } from "lucide-react";
import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBlock } from "@/components/views/view-shell";
import { useWorkspace } from "@/components/workspace/provider";
import { adminApi, adminErrorMessage, inviteState, ROLE_LABEL, type InviteLink, type WorkspaceRole } from "@/lib/admin";
import { toast } from "@/lib/toast";

import { NativeSelect, Section, SkeletonBlock, Spinner } from "./controls";
import { InviteLinkForm, InviteLinkRow } from "./invite-links";

export function InvitationsTab() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <InviteLinksSection />
      <AddByEmailSection />
    </div>
  );
}

function InviteLinksSection() {
  const ws = useWorkspace();
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [showInactive, setShowInactive] = useState(false);
  const [revoking, setRevoking] = useState<InviteLink | null>(null);

  useEffect(() => {
    let live = true;
    adminApi
      .listInviteLinks(ws.workspaceId)
      .then((l) => {
        if (!live) return;
        setLinks(l);
        setError("");
      })
      .catch((err) => live && setError(adminErrorMessage(err, "Couldn't load invite links")));
    return () => {
      live = false;
    };
  }, [ws.workspaceId, attempt]);

  const active = (links ?? []).filter((l) => inviteState(l) === "active");
  const inactive = (links ?? []).filter((l) => inviteState(l) !== "active");

  const revoke = async (link: InviteLink) => {
    setLinks((ls) => ls?.map((l) => (l.id === link.id ? { ...l, revoked: true } : l)) ?? ls);
    try {
      await adminApi.revokeInviteLink(link.id);
      toast.success("Invite link revoked");
    } catch (err) {
      setLinks((ls) => ls?.map((l) => (l.id === link.id ? { ...l, revoked: link.revoked } : l)) ?? ls);
      throw new Error(adminErrorMessage(err, "Couldn't revoke the link"));
    }
  };

  return (
    <>
      <Section
        title="Create an invite link"
        description="Anyone with the link can join until it expires or runs out of uses. Guests only get the channels you choose."
      >
        <InviteLinkForm onCreated={(l) => setLinks((ls) => [l, ...(ls ?? [])])} />
      </Section>

      <Section
        title={`Invite links${links ? ` · ${active.length} active` : ""}`}
        description="Revoke a link to stop new people joining with it. People who already joined keep access."
        actions={
          inactive.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowInactive((v) => !v)} aria-expanded={showInactive}>
              {showInactive ? "Hide" : "Show"} inactive ({inactive.length})
            </Button>
          ) : null
        }
      >
        {error && !links ? (
          <ErrorBlock message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !links ? (
          <SkeletonBlock rows={3} />
        ) : active.length === 0 && !showInactive ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-mention text-mention-foreground">
              <Link2 className="size-5" />
            </span>
            <p className="font-bold">No active invite links</p>
            <p className="text-sm text-muted-foreground">Create one above and share it with your team.</p>
          </div>
        ) : (
          <ul className="-mx-4 -my-4 divide-y sm:-mx-5">
            {[...active, ...(showInactive ? inactive : [])].map((l) => (
              <InviteLinkRow key={l.id} link={l} onRevoke={setRevoking} />
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this invite link?"
        description="Nobody new will be able to join with it. You can always create a new link."
        confirmLabel="Revoke link"
        destructive
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      />
    </>
  );
}

function AddByEmailSection() {
  const ws = useWorkspace();
  const meRole = (ws.me && ws.memberById[ws.me.id]?.role) || "member";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const roles: WorkspaceRole[] = meRole === "owner" ? ["member", "guest", "admin"] : ["member", "guest"];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await adminApi.addByEmail(ws.workspaceId, email.trim(), role);
      await ws.reloadMembers();
      toast.success(`${email.trim()} was added to ${ws.workspace?.name ?? "the workspace"}`);
      setEmail("");
    } catch (err) {
      setError(adminErrorMessage(err, "Couldn't add this person"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Add by email" description="Add someone who already has a Worklio account. Everyone else can join with an invite link.">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Mail className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            aria-label="Email address"
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <NativeSelect aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} className="w-auto">
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" disabled={busy || !email.trim()} className="bg-send text-white hover:bg-send/90">
          {busy && <Spinner />}
          Add to workspace
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </Section>
  );
}
