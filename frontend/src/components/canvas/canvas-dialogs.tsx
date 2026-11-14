"use client";

import { Check, Copy, FileText, Globe, Hash, Loader2, Lock, SmilePlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EmojiPicker } from "@/components/chat/emoji-picker";
import { UserAvatar } from "@/components/chat/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MemberPicker } from "@/components/workspace/member-picker";
import { useWorkspace } from "@/components/workspace/provider";
import { canvasApi, canvasHref, type Canvas, type CanvasAccess } from "@/lib/canvas";
import { copyText } from "@/lib/clipboard";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { TEMPLATES } from "./templates";

/** An emoji "icon" button with a picker; `null` clears it. */
export function EmojiButton({
  value,
  onChange,
  disabled,
  size = "lg",
  label = "Canvas icon",
}: {
  value: string | null;
  onChange: (emoji: string | null) => void;
  disabled?: boolean;
  size?: "md" | "lg";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = size === "lg" ? "size-12 text-[2rem] rounded-xl" : "size-9 text-xl rounded-lg";
  if (disabled) {
    return value ? (
      <span className={cn("inline-flex shrink-0 items-center justify-center", box)} aria-label={label} role="img">
        {value}
      </span>
    ) : null;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={value ? `${label}: ${value}. Change icon` : "Add icon"}
            className={cn(
              "inline-flex shrink-0 items-center justify-center leading-none transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
              box,
              !value && "border border-dashed text-muted-foreground",
            )}
          />
        }
      >
        {value ?? <SmilePlus className={size === "lg" ? "size-5" : "size-4"} aria-hidden />}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <EmojiPicker
          onPick={(e) => {
            onChange(e);
            setOpen(false);
          }}
        />
        {value && (
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Remove icon
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AccessOption({
  value,
  current,
  onSelect,
  icon,
  title,
  description,
}: {
  value: CanvasAccess;
  current: CanvasAccess;
  onSelect: (v: CanvasAccess) => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  const on = value === current;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
        on ? "border-link/50 bg-mention/40" : "hover:bg-muted/60",
      )}
    >
      <input
        type="radio"
        name="canvas-access"
        value={value}
        checked={on}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md", on ? "bg-link/15 text-link" : "bg-muted")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      {on && <Check className="mt-1 size-4 shrink-0 text-link" aria-hidden />}
    </label>
  );
}

/** Share settings for a canvas: workspace-wide or private with explicit members. */
export function ShareDialog({
  canvas,
  open,
  onOpenChange,
  onSaved,
}: {
  canvas: Canvas;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (c: Canvas) => void;
}) {
  const { workspaceId, me, memberById, channels, isAdmin } = useWorkspace();
  const [access, setAccess] = useState<CanvasAccess>(canvas.access);
  const [memberIds, setMemberIds] = useState<string[]>(canvas.member_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const channel = canvas.channel_id ? channels.find((c) => c.id === canvas.channel_id) : undefined;
  const canManage = !canvas.is_channel_canvas && (isAdmin || canvas.created_by === me?.id);
  const dirty =
    access !== canvas.access ||
    (access === "private" && [...memberIds].sort().join() !== [...(canvas.member_ids ?? [])].sort().join());

  function handleOpenChange(next: boolean) {
    if (next) {
      setAccess(canvas.access);
      setMemberIds(canvas.member_ids ?? []);
      setCopied(false);
    }
    onOpenChange(next);
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await canvasApi.update(canvas.id, {
        access,
        member_ids: access === "private" ? memberIds.filter((id) => id !== canvas.created_by) : [],
      });
      onSaved(saved);
      toast.success(access === "private" ? "Canvas is now private" : "Canvas shared with the workspace");
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't update sharing"));
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}${canvasHref(workspaceId, canvas.id)}`;
    try {
      await copyText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  const owner = memberById[canvas.created_by];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">Share “{canvas.title || "Untitled"}”</DialogTitle>
          <DialogDescription>
            {canvas.is_channel_canvas
              ? "This is a channel canvas: everyone in the channel can open and edit it."
              : "Choose who can find, open and edit this canvas."}
          </DialogDescription>
        </DialogHeader>

        {canvas.is_channel_canvas ? (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <span className="flex size-8 items-center justify-center rounded-md bg-muted">
              <Hash className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">{channel ? `#${channel.name}` : "Channel members"}</span>
              <span className="block text-xs text-muted-foreground">Access follows channel membership</span>
            </span>
          </div>
        ) : (
          <fieldset className="space-y-2" disabled={!canManage || saving}>
            <legend className="sr-only">Access</legend>
            <AccessOption
              value="workspace"
              current={access}
              onSelect={setAccess}
              icon={<Globe className="size-4" aria-hidden />}
              title="Workspace"
              description="Everyone in the workspace can find and edit it"
            />
            <AccessOption
              value="private"
              current={access}
              onSelect={setAccess}
              icon={<Lock className="size-4" aria-hidden />}
              title="Private"
              description="Only you and the people you invite"
            />
            {access === "private" && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-bold">People with access</p>
                {owner && (
                  <div className="flex items-center gap-2 text-sm">
                    <UserAvatar id={owner.user_id} name={owner.full_name} size="sm" />
                    <span className="truncate">{owner.full_name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">Owner</span>
                  </div>
                )}
                {canManage && (
                  <MemberPicker selected={memberIds} onChange={setMemberIds} exclude={[canvas.created_by]} />
                )}
              </div>
            )}
            {!canManage && (
              <p className="text-xs text-muted-foreground">Only the canvas owner or a workspace admin can change sharing.</p>
            )}
          </fieldset>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => void copyLink()}>
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
          </Button>
          {canManage && (
            <Button onClick={() => void save()} disabled={!dirty || saving} className="bg-send text-white hover:bg-send/90">
              {saving && <Loader2 className="animate-spin" />} Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "New canvas": title, icon, access (+ members), optional starter template (applied once opened). */
export function CreateCanvasDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (c: Canvas, templateId: string | null) => void;
}) {
  const { workspaceId } = useWorkspace();
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [access, setAccess] = useState<CanvasAccess>("workspace");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle("");
      setEmoji(null);
      setAccess("workspace");
      setMemberIds([]);
      setTemplateId(null);
      setError("");
    }
    onOpenChange(next);
  }

  async function create() {
    const t = title.trim();
    setSaving(true);
    setError("");
    try {
      const c = await canvasApi.create(workspaceId, {
        title: t || "Untitled",
        emoji,
        access: access === "private" ? "private" : "workspace",
        member_ids: access === "private" ? memberIds : [],
      });
      onCreated(c, templateId);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the canvas"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">New canvas</DialogTitle>
          <DialogDescription>A shared doc for notes, plans and specs — edited together in real time.</DialogDescription>
        </DialogHeader>
        <form
          id="create-canvas-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="flex items-center gap-2">
            <EmojiButton value={emoji} onChange={setEmoji} size="md" />
            <label htmlFor="new-canvas-title" className="sr-only">
              Title
            </label>
            <Input
              id="new-canvas-title"
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled canvas"
              className="h-9 text-base font-semibold"
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold">Start from</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label="Template">
              {[{ id: null, name: "Blank", emoji: "📄" }, ...TEMPLATES].map((t) => {
                const on = templateId === t.id;
                return (
                  <button
                    key={t.id ?? "blank"}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setTemplateId(t.id);
                      if (t.id && !title.trim()) setTitle("title" in t ? t.title : "");
                      if (t.id && !emoji) setEmoji(t.emoji);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      on ? "border-link/50 bg-mention/40" : "hover:bg-muted/60",
                    )}
                  >
                    <span aria-hidden>{t.emoji}</span>
                    <span className="truncate">{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <fieldset className="space-y-2" disabled={saving}>
            <legend className="mb-1.5 text-xs font-bold">Who can access</legend>
            <AccessOption
              value="workspace"
              current={access}
              onSelect={setAccess}
              icon={<Globe className="size-4" aria-hidden />}
              title="Workspace"
              description="Everyone in the workspace"
            />
            <AccessOption
              value="private"
              current={access}
              onSelect={setAccess}
              icon={<Lock className="size-4" aria-hidden />}
              title="Private"
              description="Only you and the people you invite"
            />
            {access === "private" && <MemberPicker selected={memberIds} onChange={setMemberIds} />}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-canvas-form" disabled={saving} className="bg-send text-white hover:bg-send/90">
            {saving ? <Loader2 className="animate-spin" /> : <FileText />} Create canvas
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
