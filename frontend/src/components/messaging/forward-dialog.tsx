"use client";

import { Hash, Loader2, Lock, Search, X } from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type Channel, type Message } from "@/lib/api";
import { decodeMentions } from "@/lib/format";
import { messaging } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { useGroupsById } from "./use-groups";

const MAX_TARGETS = 10;

/** A destination: an existing conversation, or a person we don't have a 1:1 DM with yet. */
type Target =
  | { kind: "channel"; key: string; channel: Channel; label: string }
  | { kind: "person"; key: string; userId: string; label: string };

export function ForwardDialog({
  message: m,
  open,
  onOpenChange,
}: {
  message: Message;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Target[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState(0);

  const targets: Target[] = (() => {
    const convs: Target[] = ws.channels
      .filter((c) => c.is_member && !c.is_archived)
      .map((c) => ({ kind: "channel", key: `c:${c.id}`, channel: c, label: ws.channelLabel(c) }));
    const dmPeers = new Set(
      ws.channels
        .filter((c) => c.kind === "dm" && c.member_ids.length === 2)
        .flatMap((c) => c.member_ids.filter((id) => id !== ws.me?.id)),
    );
    const people: Target[] = ws.members
      .filter((p) => p.user_id !== ws.me?.id && !dmPeers.has(p.user_id))
      .map((p) => ({ kind: "person", key: `p:${p.user_id}`, userId: p.user_id, label: p.full_name }));
    return [...convs, ...people];
  })();

  const q = query.trim().toLowerCase();
  const results = targets
    .filter((t) => !picked.some((p) => p.key === t.key))
    .filter((t) => !q || t.label.toLowerCase().includes(q))
    .slice(0, 50);
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  const pick = (t: Target) => {
    if (picked.length >= MAX_TARGETS) {
      toast.error(`You can forward to up to ${MAX_TARGETS} conversations at once.`);
      return;
    }
    setPicked((p) => [...p, t]);
    setQuery("");
    setCursor(0);
  };

  const submit = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError("");
    try {
      const ids: string[] = [];
      for (const t of picked) {
        if (t.kind === "channel") ids.push(t.channel.id);
        else {
          const dm = await api<Channel>(`/workspaces/${ws.workspaceId}/dms`, {
            method: "POST",
            body: JSON.stringify({ user_ids: [t.userId] }),
          });
          ids.push(dm.id);
        }
      }
      const sent = await messaging.forward(m.id, ids, comment);
      if (picked.some((t) => t.kind === "person")) ws.reloadChannels().catch(() => {});
      toast.success(
        sent.length === 1 || picked.length === 1 ? `Forwarded to ${picked[0].label}` : `Forwarded to ${picked.length} conversations`,
      );
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't forward the message"));
    } finally {
      setBusy(false);
    }
  };

  const author = ws.memberById[m.author_id]?.full_name ?? "Unknown";
  const preview = decodeMentions(m.body, ws.memberById, groups);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-black">Forward message</DialogTitle>
          <DialogDescription>Share this message in other channels or direct messages.</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border focus-within:border-foreground/40">
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 pt-2">
              {picked.map((t) => (
                <span key={t.key} className="flex items-center gap-1 rounded-md bg-mention py-0.5 pr-1 pl-1.5 text-xs font-bold text-mention-foreground">
                  <TargetIcon target={t} />
                  <span className="max-w-40 truncate">{t.label}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${t.label}`}
                    onClick={() => setPicked((p) => p.filter((x) => x.key !== t.key))}
                    className="rounded p-0.5 hover:bg-background/60"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="forward-results"
              aria-activedescendant={results[active] ? `fwd-${results[active].key}` : undefined}
              placeholder={picked.length ? "Add another…" : "Search channels or people"}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, results.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && results[active] && query) {
                  e.preventDefault();
                  pick(results[active]);
                } else if (e.key === "Backspace" && !query && picked.length) {
                  setPicked((p) => p.slice(0, -1));
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
          </div>
        </div>

        <ul id="forward-results" role="listbox" className="-mt-2 max-h-48 overflow-y-auto rounded-lg border">
          {results.length === 0 && <li className="p-3 text-center text-sm text-muted-foreground">No matches</li>}
          {results.map((t, i) => (
            <li
              key={t.key}
              id={`fwd-${t.key}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(t)}
              onMouseEnter={() => setCursor(i)}
              className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === active && "bg-muted")}
            >
              <TargetIcon target={t} />
              <span className="min-w-0 truncate font-bold">{t.label}</span>
              {t.kind === "person" && <span className="text-xs text-muted-foreground">Direct message</span>}
            </li>
          ))}
        </ul>

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={4000}
          rows={2}
          placeholder="Add a message, if you like"
          className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus:border-foreground/40 sm:text-sm"
        />

        <div className="rounded-lg border-l-4 border-border bg-muted/40 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-bold">
            <UserAvatar id={m.author_id} name={author} size="xs" /> {author}
          </div>
          <p className="mt-0.5 line-clamp-3 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {preview || `${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}`}
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!picked.length || busy} className="bg-send text-white hover:bg-send/90">
            {busy && <Loader2 className="animate-spin" />}
            Forward
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TargetIcon({ target: t }: { target: Target }) {
  const ws = useWorkspace();
  if (t.kind === "person") return <UserAvatar id={t.userId} name={t.label} size="xs" />;
  if (t.channel.kind === "dm") {
    const other = t.channel.member_ids.find((id) => id !== ws.me?.id) ?? ws.me?.id ?? "";
    return <UserAvatar id={other} name={t.label} size="xs" />;
  }
  return t.channel.kind === "private" ? <Lock className="size-3.5 shrink-0" /> : <Hash className="size-3.5 shrink-0" />;
}
