"use client";

import { BarChart3, Check, GripVertical, Loader2, Lock, Plus, X } from "lucide-react";
import { useState } from "react";

import { UserAvatar } from "@/components/chat/user-avatar";
import { useWorkspace } from "@/components/workspace/provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Message } from "@/lib/api";
import { messaging, type Poll } from "@/lib/messaging";
import { errorMessage, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const MAX_OPTIONS = 10;

/** Live poll card inside a message. */
export function PollCard({ poll: live, authorId }: { poll: Poll; authorId: string }) {
  const { me, memberById } = useWorkspace();
  // My votes: the server only sends them to me (broadcasts omit them), so keep my own copy.
  const [mine, setMine] = useState<{ pollId: string; votes: string[] } | null>(null);
  // A vote in flight: tallies are adjusted until a newer poll snapshot arrives (`of` !== live).
  const [inflight, setInflight] = useState<{ of: Poll; base: string[]; next: string[] } | null>(null);
  // The poll returned by my vote request, valid until the next broadcast replaces `live`.
  const [fresh, setFresh] = useState<{ of: Poll; poll: Poll } | null>(null);
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const poll = fresh?.of === live ? fresh.poll : live;
  const myVotes = mine?.pollId === poll.id ? mine.votes : (poll.my_votes ?? []);
  const isAuthor = me?.id === authorId;
  const voted = myVotes.length > 0;
  const showResults = voted || poll.closed;

  const adjust = inflight?.of === live && fresh?.of !== live ? inflight : null;
  const options = poll.options.map((o) => {
    if (!adjust) return o;
    const had = adjust.base.includes(o.id);
    const has = adjust.next.includes(o.id);
    const votes = Math.max(0, o.votes + (has && !had ? 1 : 0) - (had && !has ? 1 : 0));
    const voter_ids =
      poll.anonymous || !me
        ? o.voter_ids
        : has && !o.voter_ids.includes(me.id)
          ? [...o.voter_ids, me.id]
          : !has
            ? o.voter_ids.filter((id) => id !== me.id)
            : o.voter_ids;
    return { ...o, votes, voter_ids };
  });
  const totalVotes = options.reduce((n, o) => n + o.votes, 0);
  const totalVoters = Math.max(
    0,
    poll.total_voters + (adjust ? (adjust.next.length ? 1 : 0) - (adjust.base.length ? 1 : 0) : 0),
  );
  const leader = Math.max(0, ...options.map((o) => o.votes));

  const submit = async (next: string[]) => {
    if (poll.closed || pending) return;
    const prev = mine;
    const of = live;
    setMine({ pollId: poll.id, votes: next });
    setInflight({ of, base: myVotes, next });
    setPending(true);
    try {
      const res = await messaging.vote(poll.id, next);
      const got =
        res && "options" in res
          ? (res as Poll)
          : res && "poll" in res
            ? ((res as Message & { poll?: Poll | null }).poll ?? null)
            : null;
      if (got) {
        setFresh({ of, poll: got });
        if (got.my_votes) setMine({ pollId: poll.id, votes: got.my_votes });
      }
    } catch (err) {
      setMine(prev);
      setInflight(null);
      toast.error(`Couldn't record your vote: ${errorMessage(err)}`);
    } finally {
      setPending(false);
    }
  };

  const toggle = (optionId: string) => {
    if (poll.multiple) {
      submit(myVotes.includes(optionId) ? myVotes.filter((id) => id !== optionId) : [...myVotes, optionId]);
    } else {
      submit(myVotes.includes(optionId) ? [] : [optionId]);
    }
  };

  const close = async () => {
    setClosing(true);
    try {
      await messaging.closePoll(poll.id);
      toast.success("Poll closed");
    } catch (err) {
      toast.error(`Couldn't close the poll: ${errorMessage(err)}`);
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="mt-1.5 w-full max-w-md rounded-xl border bg-background p-3 shadow-xs">
      <div className="mb-2 flex items-start gap-2">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-link" />
        <div className="min-w-0 flex-1">
          <p className="text-msg font-bold break-words">{poll.question}</p>
          <p className="text-xs text-muted-foreground">
            {poll.closed ? "Closed" : poll.multiple ? "Select one or more" : "Select one"}
            {poll.anonymous && " · Anonymous"}
          </p>
        </div>
        {poll.closed && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
            <Lock className="size-3" /> Final results
          </span>
        )}
      </div>

      <ul className="space-y-1.5" role={poll.multiple ? "group" : "radiogroup"} aria-label={poll.question}>
        {options.map((o) => {
          const selected = myVotes.includes(o.id);
          const pct = totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0;
          const winning = poll.closed && o.votes > 0 && o.votes === leader;
          return (
            <li key={o.id}>
              <button
                type="button"
                role={poll.multiple ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={poll.closed}
                onClick={() => toggle(o.id)}
                className={cn(
                  "relative flex min-h-9 w-full items-center gap-2 overflow-hidden rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors",
                  selected ? "border-link/60" : "hover:border-foreground/30",
                  poll.closed && "cursor-default",
                )}
              >
                {showResults && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 transition-[width] duration-500",
                      selected || winning ? "bg-link/15" : "bg-muted",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                )}
                <span
                  className={cn(
                    "relative flex size-4 shrink-0 items-center justify-center border",
                    poll.multiple ? "rounded" : "rounded-full",
                    selected ? "border-link bg-link text-white" : "border-muted-foreground/50",
                  )}
                >
                  {selected && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className={cn("relative min-w-0 flex-1 break-words", winning && "font-bold")}>{o.text}</span>
                {!poll.anonymous && o.voter_ids.length > 0 && (
                  <span className="relative hidden -space-x-1 sm:flex" title={o.voter_ids.map((id) => memberById[id]?.full_name ?? "Someone").join(", ")}>
                    {o.voter_ids.slice(0, 3).map((id) => (
                      <UserAvatar key={id} id={id} name={memberById[id]?.full_name ?? "?"} size="xs" className="ring-1 ring-background" />
                    ))}
                  </span>
                )}
                {showResults && (
                  <span className="relative shrink-0 text-xs font-bold text-muted-foreground tabular-nums">
                    {pct}% <span className="font-normal">({o.votes})</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {totalVoters} {totalVoters === 1 ? "vote" : "votes"}
        </span>
        {pending && <Loader2 className="size-3 animate-spin" />}
        {!poll.closed && !voted && <span>· Vote to see results</span>}
        {!poll.closed && voted && !poll.multiple && <span>· Tap your choice again to remove your vote</span>}
        {isAuthor && !poll.closed && (
          <button
            type="button"
            onClick={close}
            disabled={closing}
            className="ml-auto rounded px-1.5 py-0.5 font-bold text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            {closing ? "Closing…" : "Close poll"}
          </button>
        )}
      </div>
    </div>
  );
}

type Draft = { key: string; text: string };
const newOption = (): Draft => ({ key: crypto.randomUUID(), text: "" });

/** "Create a poll" dialog. Posts through the polls API and hands back the new message. */
export function PollDialog({
  open,
  onOpenChange,
  channelId,
  parentId,
  initial,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  parentId?: string | null;
  initial?: { question?: string; options?: string[] };
  onCreated?: (m: Message) => void;
}) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [options, setOptions] = useState<Draft[]>(() => {
    const seed = (initial?.options ?? []).map((text) => ({ key: crypto.randomUUID(), text }));
    while (seed.length < 2) seed.push(newOption());
    return seed;
  });
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filled = options.map((o) => o.text.trim()).filter(Boolean);
  const dupes = new Set(filled.map((t) => t.toLowerCase())).size !== filled.length;
  const valid = question.trim().length > 0 && filled.length >= 2 && !dupes;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const m = await messaging.createPoll(channelId, {
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
        parent_id: parentId ?? null,
      });
      onCreated?.(m);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the poll"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="text-lg font-black">Create a poll</DialogTitle>
            <DialogDescription>Ask a question and let people vote. Results update live.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="poll-question" className="text-sm font-bold">
              Question
            </label>
            <Input
              id="poll-question"
              value={question}
              maxLength={300}
              autoFocus
              placeholder="Where should we have the offsite?"
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-bold">Options</span>
            {options.map((o, i) => (
              <div key={o.key} className="flex items-center gap-1.5">
                <GripVertical className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />
                <Input
                  value={o.text}
                  maxLength={150}
                  aria-label={`Option ${i + 1}`}
                  placeholder={`Option ${i + 1}`}
                  onChange={(e) => setOptions((all) => all.map((x) => (x.key === o.key ? { ...x, text: e.target.value } : x)))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && i === options.length - 1 && options.length < MAX_OPTIONS && o.text.trim()) {
                      e.preventDefault();
                      setOptions((all) => [...all, newOption()]);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove option ${i + 1}`}
                  disabled={options.length <= 2}
                  onClick={() => setOptions((all) => all.filter((x) => x.key !== o.key))}
                >
                  <X />
                </Button>
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <button
                type="button"
                onClick={() => setOptions((all) => [...all, newOption()])}
                className="flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-sm font-bold text-link hover:bg-muted"
              >
                <Plus className="size-4" /> Add option
              </button>
            )}
            {dupes && <p className="text-xs text-destructive">Options must be different.</p>}
          </div>
          <div className="grid gap-2 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} className="size-4 accent-[var(--color-link,currentColor)]" />
              Allow multiple choices
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="size-4" />
              Anonymous voting <span className="text-xs text-muted-foreground">(hide who voted for what)</span>
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy} className="bg-send text-white hover:bg-send/90">
              {busy && <Loader2 className="animate-spin" />}
              Create poll
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
