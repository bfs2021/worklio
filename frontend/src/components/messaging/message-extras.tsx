"use client";

import { Forward, History, Loader2, Pin, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatMessage } from "@/lib/format";
import { dayLabel, messagePath, timeLabel } from "@/lib/messages";
import { hostOf, messaging, type ForwardedFrom, type MessageEdit, type Unfurl } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { useGroupsById } from "./use-groups";

/** "Pinned by Alex" strip above a pinned message. */
export function PinnedLabel({ pinnedBy }: { pinnedBy?: string | null }) {
  const { me, memberById } = useWorkspace();
  const who = pinnedBy ? (pinnedBy === me?.id ? "you" : (memberById[pinnedBy]?.full_name ?? "someone")) : null;
  return (
    <div className="mb-0.5 flex items-center gap-1 text-xs font-bold text-amber-700 dark:text-amber-400">
      <Pin className="size-3 fill-current" /> Pinned{who ? ` by ${who}` : ""}
    </div>
  );
}

/** A forwarded message: quoted card with the original author, channel, time and a jump link. */
export function ForwardedCard({ from }: { from: ForwardedFrom }) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const author = ws.memberById[from.author_id]?.full_name ?? "Unknown";
  const channel = ws.channels.find((c) => c.id === from.channel_id);
  const where = channel ? (channel.kind === "dm" ? ws.channelLabel(channel) : `#${ws.channelLabel(channel)}`) : null;
  const href = messagePath({ id: from.message_id, workspace_id: ws.workspaceId, channel_id: from.channel_id, parent_id: null });
  return (
    <div className="mt-1 w-full max-w-xl border-l-4 border-border py-0.5 pl-3">
      <div className="mb-0.5 flex items-center gap-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
        <Forward className="size-3" /> Forwarded
      </div>
      <div className="flex items-center gap-1.5">
        <UserAvatar id={from.author_id} name={author} size="sm" />
        <span className="truncate text-sm font-bold">{author}</span>
      </div>
      <div className="mt-0.5 line-clamp-6 text-msg break-words whitespace-pre-wrap">
        {from.body_preview ? (
          formatMessage(from.body_preview, { names: ws.memberById, meId: ws.me?.id, groups })
        ) : (
          <em className="text-muted-foreground">Attachment</em>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {where ? <span>Posted in {where}</span> : <span>From a conversation you can&apos;t see</span>}
        <span aria-hidden>·</span>
        <span>
          {dayLabel(from.created_at)} at {timeLabel(from.created_at)}
        </span>
        {channel && (
          <>
            <span aria-hidden>·</span>
            <Link href={href} scroll={false} className="font-bold text-link hover:underline">
              View message
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/** Link previews under a message; the author can hide one with ×. */
export function UnfurlCards({ messageId, unfurls, canHide }: { messageId: string; unfurls: Unfurl[]; canHide: boolean }) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // The server addresses previews by position in the current list, so index the visible ones.
  const visible = unfurls.filter((u) => !hidden.has(u.url)).map((u, index) => ({ u, index }));
  if (!visible.length) return null;

  const hide = async (u: Unfurl, index: number) => {
    setHidden((h) => new Set(h).add(u.url));
    try {
      await messaging.hideUnfurl(messageId, index);
    } catch (err) {
      setHidden((h) => {
        const next = new Set(h);
        next.delete(u.url);
        return next;
      });
      toast.error(`Couldn't remove the preview: ${errorMessage(err)}`);
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {visible.map(({ u, index }) => (
        <UnfurlCard key={`${u.url}-${index}`} unfurl={u} onHide={canHide ? () => hide(u, index) : undefined} />
      ))}
    </div>
  );
}

function UnfurlCard({ unfurl: u, onHide }: { unfurl: Unfurl; onHide?: () => void }) {
  const [imageOk, setImageOk] = useState(true);
  const [iconOk, setIconOk] = useState(true);
  const site = u.site_name || hostOf(u.url);
  if (!u.title && !u.description && !u.image_url) return null;
  return (
    <div className="group/unfurl relative flex w-full max-w-xl gap-3 border-l-4 border-link/40 py-0.5 pr-7 pl-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
          {u.favicon_url && iconOk && (
            // eslint-disable-next-line @next/next/no-img-element -- remote favicon, not optimisable
            <img
              src={u.favicon_url}
              alt=""
              className="size-3.5 rounded-sm"
              referrerPolicy="no-referrer"
              onError={() => setIconOk(false)}
            />
          )}
          <span className="truncate">{site}</span>
        </div>
        {u.title && (
          <a
            href={u.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-0.5 line-clamp-2 text-sm font-bold text-link hover:underline"
          >
            {u.title}
          </a>
        )}
        {u.description && <p className="mt-0.5 line-clamp-3 text-sm text-foreground/80">{u.description}</p>}
        {u.image_url && imageOk && (
          <a href={u.url} target="_blank" rel="noreferrer noopener" className="mt-2 block w-fit overflow-hidden rounded-lg border">
            {/* eslint-disable-next-line @next/next/no-img-element -- remote preview image */}
            <img
              src={u.image_url}
              alt={u.title ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageOk(false)}
              className="max-h-64 max-w-full object-cover sm:max-w-sm"
            />
          </a>
        )}
      </div>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          aria-label={`Remove preview for ${site}`}
          title="Remove preview"
          className="absolute top-0 right-0 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/unfurl:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** "(edited)" label that opens the edit history. */
export function EditedLabel({ messageId, editedAt, editCount }: { messageId: string; editedAt: string; editCount?: number }) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ edits: MessageEdit[] | null; error: string; loading: boolean }>({
    edits: null,
    error: "",
    loading: false,
  });

  const load = () => {
    setState({ edits: null, error: "", loading: true });
    messaging
      .edits(messageId)
      .then((edits) => setState({ edits, error: "", loading: false }))
      .catch((err) => setState({ edits: null, error: errorMessage(err), loading: false }));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) load();
      }}
    >
      <PopoverTrigger
        className="ml-1 rounded text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={`Edited ${dayLabel(editedAt).toLowerCase()} at ${timeLabel(editedAt)} · view history`}
      >
        (edited{editCount && editCount > 1 ? ` ×${editCount}` : ""})
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-bold">
          <History className="size-4" /> Edit history
        </div>
        <div className="max-h-72 overflow-y-auto">
          {state.loading && <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />}
          {state.error && (
            <p className="p-3 text-sm text-destructive">
              Couldn&apos;t load history: {state.error}.{" "}
              <button onClick={load} className="font-bold underline">
                Retry
              </button>
            </p>
          )}
          {state.edits?.length === 0 && <p className="p-3 text-sm text-muted-foreground">No earlier versions.</p>}
          {state.edits?.map((e, i) => (
            <div key={`${e.edited_at}-${i}`} className={cn("px-3 py-2", i > 0 && "border-t")}>
              <div className="mb-0.5 text-[11px] font-bold text-muted-foreground">
                {dayLabel(e.edited_at)} at {timeLabel(e.edited_at)}
              </div>
              <div className="text-sm break-words whitespace-pre-wrap">
                {e.body ? (
                  formatMessage(e.body, { names: ws.memberById, meId: ws.me?.id, groups })
                ) : (
                  <em className="text-muted-foreground">Empty</em>
                )}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
