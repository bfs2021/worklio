"use client";

import { Camera, Loader2, Mail, Palette, ShieldCheck, SmilePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import {
  activeStatus,
  AVATAR_TYPES,
  checkAvatarFile,
  describeExpiry,
  isValidTimeZone,
  useNow,
} from "@/components/profile/profile-utils";
import { StatusPickerDialog } from "@/components/profile/status-picker";
import { TimeZoneSelect } from "@/components/profile/timezone-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type User } from "@/lib/api";
import { errorMessage, toast } from "@/lib/toast";

import { useWorkspace } from "./provider";

/** Your own profile: photo, display name, title, pronouns, phone, time zone and status. */
export function ProfileDialog() {
  const ws = useWorkspace();
  return (
    <Dialog open={ws.profileOpen} onOpenChange={ws.setProfileOpen}>
      <DialogContent className="gap-0 overflow-x-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Edit your profile</DialogTitle>
        <DialogDescription className="sr-only">
          Update your photo, name, contact details, time zone and status.
        </DialogDescription>
        {ws.profileOpen && ws.me && <ProfileBody me={ws.me} />}
      </DialogContent>
    </Dialog>
  );
}

type Fields = { full_name: string; title: string; pronouns: string; phone: string; timezone: string };

const LIMITS: Record<keyof Fields, number> = { full_name: 200, title: 100, pronouns: 40, phone: 40, timezone: 64 };

function fieldsOf(me: User): Fields {
  return {
    full_name: me.full_name,
    title: me.title ?? "",
    pronouns: me.pronouns ?? "",
    phone: me.phone ?? "",
    timezone: me.timezone ?? "",
  };
}

function ProfileBody({ me }: { me: User }) {
  const ws = useWorkspace();
  const now = useNow();
  const [initial, setInitial] = useState<Fields>(() => fieldsOf(me));
  const [form, setForm] = useState<Fields>(initial);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const role = ws.memberById[me.id]?.role;
  const status = activeStatus(me, now);
  const changed = (Object.keys(form) as (keyof Fields)[]).filter((k) => form[k].trim() !== initial[k].trim());
  const nameValid = form.full_name.trim().length > 0;
  const dirty = changed.length > 0 && nameValid;

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value.slice(0, LIMITS[k]) }));

  const applyUser = (u: User) => {
    ws.setMe(u);
    ws.reloadMembers().catch(() => {});
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    if (form.timezone && !isValidTimeZone(form.timezone)) {
      toast.error("That time zone isn't recognised.");
      return;
    }
    setSaving(true);
    try {
      const body = Object.fromEntries(changed.map((k) => [k, form[k].trim()]));
      const updated = await api<User>("/auth/me", { method: "PATCH", body: JSON.stringify(body) });
      applyUser(updated);
      const next = fieldsOf(updated);
      setInitial(next);
      setForm(next);
      toast.success("Profile updated");
    } catch (err) {
      toast.error(`Couldn't save profile: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = checkAvatarFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setPhotoBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const updated = await api<User>("/auth/me/avatar", { method: "POST", body: form });
      applyUser(updated);
      toast.success("Photo updated");
    } catch (err) {
      toast.error(`Couldn't upload photo: ${errorMessage(err)}`);
    } finally {
      setPhotoBusy(false);
      setPreview(null);
      URL.revokeObjectURL(url);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      const updated = await api<User>("/auth/me/avatar", { method: "DELETE" });
      applyUser(updated);
      toast.success("Photo removed");
    } catch (err) {
      toast.error(`Couldn't remove photo: ${errorMessage(err)}`);
    } finally {
      setPhotoBusy(false);
    }
  };

  const avatarSrc = preview ?? me.avatar_url ?? null;
  const displayName = form.full_name.trim() || me.full_name;

  return (
    <>
      <div className="h-20 sm:h-24" style={{ backgroundImage: "var(--chrome-gradient)" }} />

      {/* Identity header */}
      {/* Avatar overlaps the banner; the name always sits below it on the card so it stays readable. */}
      <div className="-mt-10 flex flex-col gap-2.5 px-5 sm:px-6">
        <div className="relative w-fit">
          <UserAvatar
            id={me.id}
            name={displayName}
            src={avatarSrc}
            size="xl"
            className="rounded-xl ring-4 ring-popover"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={photoBusy}
            aria-label={me.avatar_url ? "Change profile photo" : "Upload profile photo"}
            className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/0 text-white opacity-0 transition hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100 focus-visible:outline-none disabled:cursor-wait"
          >
            <Camera className="size-6" />
          </button>
          {photoBusy && (
            <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white">
              <Loader2 className="size-6 animate-spin" aria-label="Uploading" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 pb-0.5">
          <div className="text-xl font-black break-words">{displayName}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {form.title.trim() && <span className="truncate">{form.title.trim()}</span>}
            {form.pronouns.trim() && <span>· {form.pronouns.trim()}</span>}
            {role && (
              <span className="flex items-center gap-1 rounded bg-muted px-1.5 text-xs capitalize">
                <ShieldCheck className="size-3" /> {role}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 px-5 pt-3 sm:px-6">
        <input
          ref={fileInput}
          type="file"
          accept={AVATAR_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={onPickPhoto}
        />
        <Button type="button" variant="outline" size="sm" disabled={photoBusy} onClick={() => fileInput.current?.click()}>
          <Camera /> {me.avatar_url ? "Change photo" : "Upload photo"}
        </Button>
        {me.avatar_url && (
          <Button type="button" variant="ghost" size="sm" disabled={photoBusy} onClick={removePhoto}>
            <Trash2 /> Remove photo
          </Button>
        )}
        <span className="self-center text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 5 MB</span>
      </div>

      {/* Status */}
      <div className="px-5 pt-5 sm:px-6">
        <div className="mb-2 text-sm font-medium">Status</div>
        <button
          type="button"
          onClick={() => setStatusOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {status ? (
            <>
              <span className="text-lg leading-none" aria-hidden>
                {status.emoji ?? "💬"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{status.text || "Status set"}</span>
                <span className="block text-xs text-muted-foreground">
                  {describeExpiry(status.expiresAt, now) ?? "Doesn't clear automatically"}
                </span>
              </span>
              <span className="text-xs font-medium text-link">Edit</span>
            </>
          ) : (
            <>
              <SmilePlus className="size-5 text-muted-foreground" />
              <span className="flex-1 text-muted-foreground">Set a status</span>
            </>
          )}
        </button>
      </div>
      <StatusPickerDialog open={statusOpen} onOpenChange={setStatusOpen} />

      <form onSubmit={save} className="space-y-4 p-5 sm:p-6">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Display name</Label>
          <Input
            id="profile-name"
            value={form.full_name}
            onChange={set("full_name")}
            maxLength={LIMITS.full_name}
            required
            aria-invalid={!nameValid || undefined}
            autoComplete="name"
          />
          <p className="text-xs text-muted-foreground">This is how people see you in messages and mentions.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="profile-title">What I do</Label>
          <Input
            id="profile-title"
            value={form.title}
            onChange={set("title")}
            maxLength={LIMITS.title}
            placeholder="e.g. Product designer, Growth team"
            autoComplete="organization-title"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="profile-pronouns">Pronouns</Label>
            <Input
              id="profile-pronouns"
              value={form.pronouns}
              onChange={set("pronouns")}
              maxLength={LIMITS.pronouns}
              placeholder="e.g. she/her"
              list="profile-pronoun-suggestions"
            />
            <datalist id="profile-pronoun-suggestions">
              <option value="she/her" />
              <option value="he/him" />
              <option value="they/them" />
            </datalist>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-phone">Phone</Label>
            <Input
              id="profile-phone"
              type="tel"
              inputMode="tel"
              value={form.phone}
              onChange={set("phone")}
              maxLength={LIMITS.phone}
              placeholder="+1 555 010 2030"
              autoComplete="tel"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="profile-timezone">Time zone</Label>
          <TimeZoneSelect
            id="profile-timezone"
            value={form.timezone}
            onChange={(tz) => setForm((f) => ({ ...f, timezone: tz }))}
          />
        </div>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <Mail className="size-4 shrink-0 text-muted-foreground" /> <span className="min-w-0 truncate">{me.email}</span>
        </div>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              ws.setProfileOpen(false);
              ws.setPreferencesOpen(true);
            }}
          >
            <Palette className="size-4" /> Appearance
          </Button>
          <div className="flex gap-2">
            {changed.length > 0 && (
              <Button type="button" variant="ghost" className="flex-1 sm:flex-none" onClick={() => setForm(initial)}>
                Reset
              </Button>
            )}
            <Button
              type="submit"
              disabled={!dirty || saving}
              className="flex-1 bg-send text-white hover:bg-send/90 sm:flex-none"
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
