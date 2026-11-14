"use client";

import { Hash, ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { ConfirmDialog } from "@/components/chat/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspace } from "@/components/workspace/provider";
import { adminApi, adminErrorMessage, settingsStore, type WorkspaceSettings } from "@/lib/admin";
import { toast } from "@/lib/toast";

import { FieldRow, Section, Spinner, WorkspaceIcon } from "./controls";

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const MAX_DEFAULT_CHANNELS = 20;

export function GeneralTab({ settings }: { settings: WorkspaceSettings }) {
  return (
    <div className="space-y-4 sm:space-y-6">
      <IconSection settings={settings} />
      <DetailsForm key={`${settings.name}\u0000${settings.slug}\u0000${settings.description ?? ""}`} settings={settings} />
      <DefaultChannels settings={settings} />
    </div>
  );
}

function IconSection({ settings }: { settings: WorkspaceSettings }) {
  const ws = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const upload = async (file: File) => {
    if (!file.type.startsWith("image/")) return toast.error("Choose an image file (PNG, JPG, GIF or WebP).");
    if (file.size > MAX_ICON_BYTES) return toast.error("Workspace icons can be up to 2 MB.");
    setBusy(true);
    try {
      await adminApi.uploadIcon(ws.workspaceId, file);
      await settingsStore.load(ws.workspaceId);
      ws.reloadWorkspaces().catch(() => {});
      toast.success("Workspace icon updated");
    } catch (err) {
      toast.error(adminErrorMessage(err, "Couldn't upload the icon"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const prev = settings.icon_url;
    settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, icon_url: null } : s));
    try {
      await adminApi.removeIcon(ws.workspaceId);
      ws.reloadWorkspaces().catch(() => {});
      toast.success("Workspace icon removed");
    } catch (err) {
      settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, icon_url: prev } : s));
      throw new Error(adminErrorMessage(err, "Couldn't remove the icon"));
    }
  };

  return (
    <Section title="Workspace icon" description="Shown in the workspace switcher, invites and notifications. Square images work best.">
      <div className="flex flex-wrap items-center gap-4">
        <WorkspaceIcon name={settings.name} url={settings.icon_url} size="xl" />
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Spinner /> : <ImagePlus />}
              {settings.icon_url ? "Replace icon" : "Upload icon"}
            </Button>
            {settings.icon_url && (
              <Button variant="destructive" disabled={busy} onClick={() => setConfirmRemove(true)}>
                <Trash2 /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG, JPG, GIF or WebP, up to 2 MB.</p>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) upload(f);
          }}
        />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the workspace icon?"
        description="Everyone will see the workspace initials instead."
        confirmLabel="Remove icon"
        destructive
        onConfirm={remove}
      />
    </Section>
  );
}

function DetailsForm({ settings }: { settings: WorkspaceSettings }) {
  const ws = useWorkspace();
  const [name, setName] = useState(settings.name);
  const [slug, setSlug] = useState(settings.slug);
  const [description, setDescription] = useState(settings.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmedName = name.trim();
  const dirty =
    trimmedName !== settings.name || slug !== settings.slug || description.trim() !== (settings.description ?? "");
  const slugValid = SLUG_RE.test(slug);
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 120;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || !slugValid || !nameValid || busy) return;
    setBusy(true);
    setError("");
    try {
      const patch = {
        ...(trimmedName !== settings.name ? { name: trimmedName } : {}),
        ...(slug !== settings.slug ? { slug } : {}),
        ...(description.trim() !== (settings.description ?? "") ? { description: description.trim() || null } : {}),
      };
      const next = await adminApi.patchSettings(ws.workspaceId, patch);
      settingsStore.set(ws.workspaceId, (s) => ({ ...(s ?? settings), ...next }));
      ws.reloadWorkspaces().catch(() => {});
      toast.success("Workspace details saved");
    } catch (err) {
      const msg = adminErrorMessage(err, "Couldn't save changes");
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <Section
        title="Workspace details"
        description="The name and address people see everywhere in Worklio."
        actions={
          <>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setName(settings.name);
                  setSlug(settings.slug);
                  setDescription(settings.description ?? "");
                  setError("");
                }}
              >
                Discard
              </Button>
            )}
            <Button type="submit" className="bg-send text-white hover:bg-send/90" disabled={!dirty || !slugValid || !nameValid || busy}>
              {busy && <Spinner />}
              Save changes
            </Button>
          </>
        }
      >
        <div className="divide-y">
          <FieldRow label="Workspace name" htmlFor="ws-name" hint="Up to 120 characters.">
            <Input id="ws-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-invalid={!nameValid} required />
          </FieldRow>
          <FieldRow label="Workspace URL" htmlFor="ws-slug" hint="Generated from the name when the workspace was created. Lowercase letters, numbers and dashes.">
            <div className="flex min-w-0 items-center rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
              <span className="shrink-0 border-r px-2.5 text-sm text-muted-foreground select-none" suppressHydrationWarning>
                {typeof window === "undefined" ? "" : window.location.host}/
              </span>
              <input
                id="ws-slug"
                value={slug}
                maxLength={64}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""))}
                aria-invalid={!slugValid}
                aria-describedby="ws-slug-help"
                className="h-8 min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none"
              />
            </div>
            <p id="ws-slug-help" className={slugValid ? "mt-1.5 text-xs text-muted-foreground" : "mt-1.5 text-xs text-destructive"}>
              {slugValid
                ? "Must be unique on this Worklio server."
                : "Use 2–64 characters: lowercase letters, numbers and dashes."}
            </p>
          </FieldRow>
          <FieldRow label="Description" htmlFor="ws-desc" hint="What this workspace is for. Shown on invites.">
            <Textarea
              id="ws-desc"
              value={description}
              maxLength={500}
              rows={3}
              placeholder="e.g. Where the Acme team plans, ships and celebrates."
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="mt-1 text-right text-[11px] text-muted-foreground tabular-nums">{description.length}/500</p>
          </FieldRow>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </Section>
    </form>
  );
}

function DefaultChannels({ settings }: { settings: WorkspaceSettings }) {
  const ws = useWorkspace();
  const publicChannels = ws.channels
    .filter((c) => c.kind === "public" && !c.is_archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = new Set(settings.default_channel_ids ?? []);

  const toggle = async (id: string) => {
    const prev = settings.default_channel_ids ?? [];
    if (!selected.has(id) && prev.length >= MAX_DEFAULT_CHANNELS) {
      toast.error(`You can pick up to ${MAX_DEFAULT_CHANNELS} default channels.`);
      return;
    }
    const next = selected.has(id) ? prev.filter((x) => x !== id) : [...prev, id];
    settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, default_channel_ids: next } : s));
    try {
      await adminApi.patchSettings(ws.workspaceId, { default_channel_ids: next });
    } catch (err) {
      settingsStore.set(ws.workspaceId, (s) => (s ? { ...s, default_channel_ids: prev } : s));
      toast.error(adminErrorMessage(err, "Couldn't update default channels"));
    }
  };

  return (
    <Section
      title="Default channels"
      description="New members join these public channels automatically. #general is always included."
    >
      {publicChannels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public channels yet.</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {publicChannels.map((c) => {
            const isGeneral = c.name === "general";
            const checked = isGeneral || selected.has(c.id);
            return (
              <li key={c.id}>
                <label className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted has-disabled:cursor-default has-disabled:opacity-70">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--color-send)]"
                    checked={checked}
                    disabled={isGeneral}
                    onChange={() => toggle(c.id)}
                  />
                  <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{c.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
