"use client";

import { AlarmClock, Bell, BellOff, Bookmark, BookmarkCheck, Forward, Languages, ListChecks, Pin, PinOff, ScrollText } from "lucide-react";
import { useState } from "react";

import { LANGUAGES, openAsk, openCreateTasks, openThreadSummary, preferredLanguage, requestTranslation } from "@/components/ai/ai-store";
import { AISparkle } from "@/components/ai/brand";
import { useWorkspace } from "@/components/workspace/provider";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useAIStatus } from "@/lib/ai";
import type { Message } from "@/lib/api";
import { decodeMentions, mentionsUser } from "@/lib/format";
import { messaging, rich } from "@/lib/messaging";
import { notifyLaterChanged } from "@/lib/productivity";
import { errorMessage, toast } from "@/lib/toast";

import { describeWhen, presetTimes } from "./natural-time";
import { useGroupsById } from "./use-groups";

/** Optimistic value that yields to the server once the server value moves away from `base`. */
type Override = { value: boolean; base: boolean } | null;
const resolve = (o: Override, server: boolean) => (o && o.base === server ? o.value : server);

export type MessageActions = ReturnType<typeof useMessageActions>;

/** State + handlers for the A1/A2 message actions (pin, save, remind, follow, forward). */
export function useMessageActions(m: Message) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const r = rich(m);
  const [pinO, setPinO] = useState<Override>(null);
  const [saveO, setSaveO] = useState<Override>(null);
  /** Authoritative follow state once known (menu opened / toggled); null = use the heuristic. */
  const [followKnown, setFollowKnown] = useState<boolean | null>(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);

  const serverPinned = !!r.pinned;
  const serverSaved = !!r.saved;
  const meId = ws.me?.id;
  const guessFollowing =
    !m.parent_id &&
    !!meId &&
    (m.author_id === meId || m.reply_user_ids.includes(meId) || mentionsUser(m.body, meId, groups));
  const pinned = resolve(pinO, serverPinned);
  const saved = resolve(saveO, serverSaved);
  const following = followKnown ?? guessFollowing;

  const togglePin = async () => {
    const next = !pinned;
    setPinO({ value: next, base: serverPinned });
    try {
      await (next ? messaging.pin(m.id) : messaging.unpin(m.id));
      toast.success(next ? "Pinned to this conversation" : "Unpinned");
    } catch (err) {
      setPinO(null);
      toast.error(`Couldn't ${next ? "pin" : "unpin"} the message: ${errorMessage(err)}`);
    }
  };

  const toggleSave = async () => {
    const next = !saved;
    setSaveO({ value: next, base: serverSaved });
    try {
      // Saving is idempotent and returns the item, which is also how we find its id to remove it.
      const item = await messaging.save(ws.workspaceId, m.id);
      if (!next) await messaging.deleteSaved(item.id);
      // Badge recount (the server's later.* echo also arrives, but this is instant).
      notifyLaterChanged({ workspaceId: ws.workspaceId });
      toast.success(next ? "Saved for later" : "Removed from Later");
    } catch (err) {
      setSaveO(null);
      toast.error(`Couldn't update Later: ${errorMessage(err)}`);
    }
  };

  /** Fetch the real follow state (called when the actions menu opens). */
  const refreshFollow = () => {
    if (m.parent_id || m.kind === "system") return;
    messaging
      .threadState(m.id)
      .then((s) => setFollowKnown(s.following))
      .catch(() => {});
  };

  const toggleFollow = async () => {
    const prev = followKnown;
    const next = !following;
    setFollowKnown(next);
    try {
      const s = await (next ? messaging.follow(m.id) : messaging.unfollow(m.id));
      if (s && typeof s.following === "boolean") setFollowKnown(s.following);
      toast.success(next ? "You'll be notified about new replies" : "You won't be notified about new replies");
    } catch (err) {
      setFollowKnown(prev);
      toast.error(`Couldn't update thread notifications: ${errorMessage(err)}`);
    }
  };

  const remind = async (when: Date) => {
    if (when.getTime() <= Date.now()) {
      toast.error("Pick a time in the future.");
      return false;
    }
    const preview = decodeMentions(m.body, ws.memberById, groups).replace(/\s+/g, " ").trim();
    const text = preview ? (preview.length > 120 ? `${preview.slice(0, 117)}…` : preview) : "Check this message";
    try {
      await messaging.remind(ws.workspaceId, { text, remind_at: when.toISOString(), message_id: m.id });
      toast.success(`I'll remind you ${describeWhen(when)}`);
      return true;
    } catch (err) {
      toast.error(`Couldn't set the reminder: ${errorMessage(err)}`);
      return false;
    }
  };

  return {
    pinned,
    saved,
    following,
    togglePin,
    toggleSave,
    toggleFollow,
    refreshFollow,
    remind,
    forwardOpen,
    setForwardOpen,
    remindOpen,
    setRemindOpen,
  };
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

/** The extra menu items for a message's "More actions" menu. */
export function MessageActionItems({
  actions: a,
  message: m,
  canPin,
  onDone,
}: {
  actions: MessageActions;
  message: Message;
  canPin: boolean;
  onDone?: () => void;
}) {
  const system = m.kind === "system";
  const isRoot = !m.parent_id;
  const run = (fn: () => unknown) => () => {
    onDone?.();
    fn();
  };
  const { tomorrow9, nextMonday9 } = presetTimes();
  return (
    <>
      {!system && (
        <DropdownMenuItem onClick={run(a.toggleSave)}>
          {a.saved ? <BookmarkCheck className="size-4 text-emerald-600" /> : <Bookmark className="size-4" />}
          {a.saved ? "Remove from Later" : "Save for later"}
        </DropdownMenuItem>
      )}
      {canPin && (
        <DropdownMenuItem onClick={run(a.togglePin)}>
          {a.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {a.pinned ? "Unpin from conversation" : "Pin to conversation"}
        </DropdownMenuItem>
      )}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <AlarmClock className="size-4" /> Remind me about this
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem onClick={run(() => a.remind(minutes(20)))}>In 20 minutes</DropdownMenuItem>
          <DropdownMenuItem onClick={run(() => a.remind(minutes(60)))}>In 1 hour</DropdownMenuItem>
          <DropdownMenuItem onClick={run(() => a.remind(minutes(180)))}>In 3 hours</DropdownMenuItem>
          <DropdownMenuItem onClick={run(() => a.remind(tomorrow9))}>Tomorrow at 9:00 AM</DropdownMenuItem>
          <DropdownMenuItem onClick={run(() => a.remind(nextMonday9))}>Next Monday at 9:00 AM</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={run(() => a.setRemindOpen(true))}>Custom…</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {!system && (
        <DropdownMenuItem onClick={run(() => a.setForwardOpen(true))}>
          <Forward className="size-4" /> Forward message…
        </DropdownMenuItem>
      )}
      {isRoot && !system && (
        <DropdownMenuItem onClick={run(a.toggleFollow)}>
          {a.following ? <BellOff className="size-4" /> : <Bell className="size-4" />}
          {a.following ? "Unfollow thread" : "Follow thread"}
        </DropdownMenuItem>
      )}
      <AIMessageItems message={m} run={run} />
    </>
  );
}

/** Worklio AI actions: translate, summarize thread, create tasks. */
function AIMessageItems({ message: m, run }: { message: Message; run: (fn: () => unknown) => () => void }) {
  const { enabled, loading } = useAIStatus();
  const system = m.kind === "system";
  const canTranslate = !system && !!m.body.trim() && !m.deleted_at;
  // A thread exists when this is a reply, or a root with replies.
  const inThread = !!m.parent_id || m.reply_count > 0;
  const canTasks = inThread || (!system && !!m.body.trim());
  if (!canTranslate && !inThread && !canTasks) return null;

  if (!loading && !enabled)
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={run(() => openAsk())} className="text-muted-foreground">
          <AISparkle className="size-4 opacity-60" /> Worklio AI is off
          <span className="ml-auto text-[11px]">Set up</span>
        </DropdownMenuItem>
      </>
    );

  const mine = preferredLanguage();
  const languages = [mine, ...LANGUAGES.filter((l) => l !== mine)];
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide uppercase">
          <AISparkle className="size-3" /> Worklio AI
        </DropdownMenuLabel>
        {canTranslate && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="size-4" /> Translate
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
              {languages.map((l, i) => (
                <DropdownMenuItem key={l} onClick={run(() => requestTranslation(m, l))}>
                  {l}
                  {i === 0 && <span className="ml-auto text-[11px] text-muted-foreground">Your language</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {inThread && (
          <DropdownMenuItem onClick={run(() => openThreadSummary(m))}>
            <ScrollText className="size-4" /> Summarize thread
          </DropdownMenuItem>
        )}
        {canTasks && (
          <DropdownMenuItem onClick={run(() => openCreateTasks(m))}>
            <ListChecks className="size-4" /> Create tasks…
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
    </>
  );
}
