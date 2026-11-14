"use client";

import { useCallback, useEffect, useState } from "react";

import { useWorkspaceEvents } from "@/components/workspace/provider";
import { api, type Message } from "@/lib/api";
import { applyMessageEvent, upsert } from "@/lib/messages";
import { errorMessage } from "@/lib/toast";

import { Composer } from "./composer";
import { MessageItem } from "./message-item";
import { MessageList } from "./message-list";
import { SidePanel } from "./side-panel";

export function ThreadPanel({
  parent,
  channelName,
  onClose,
  highlightId,
}: {
  parent: Message;
  channelName: string;
  onClose: () => void;
  /** Reply to scroll to and highlight (jump-to-message). */
  highlightId?: string | null;
}) {
  const [replies, setReplies] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Replies come in pages of 200 (oldest first); a thread loads up to 2,000 of them.
  const fetchReplies = useCallback(async () => {
    const all: Message[] = [];
    for (let i = 0; i < 10; i++) {
      const after = all.length ? `&after_id=${all[all.length - 1].id}` : "";
      const page = await api<Message[]>(`/messages/${parent.id}/replies?limit=200${after}`);
      all.push(...page);
      if (page.length < 200) break;
    }
    return all;
  }, [parent.id]);

  useEffect(() => {
    let live = true;
    fetchReplies()
      .then((r) => {
        if (!live) return;
        setReplies(r);
        setError("");
        setLoading(false);
      })
      .catch((err) => {
        if (!live) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [fetchReplies, attempt]);

  useWorkspaceEvents((e) => {
    if (e.type === "message.deleted" && e.message_id === parent.id) onClose();
    if (e.type === "resync") {
      // The socket was down: pick up replies, edits and reactions we missed.
      fetchReplies()
        .then((r) => setReplies(r))
        .catch(() => {});
      return;
    }
    setReplies((list) => applyMessageEvent(list, e, { channelId: parent.channel_id, parentId: parent.id }));
  });

  const retry = () => {
    setError("");
    setLoading(true);
    setAttempt((n) => n + 1);
  };

  return (
    <SidePanel title="Thread" subtitle={channelName} onClose={onClose}>
      {error && (
        <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
          Couldn&apos;t load replies: {error}.{" "}
          <button onClick={retry} className="font-bold underline">
            Try again
          </button>
        </div>
      )}
      <MessageList
        messages={replies}
        loading={loading}
        highlightId={highlightId}
        header={
          <div className="pt-3">
            <MessageItem message={parent} compact={false} />
            <div className="flex items-center gap-3 px-5 py-2 text-[13px] text-muted-foreground">
              <span>
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        }
      />
      <Composer
        key={parent.id}
        channelId={parent.channel_id}
        parentId={parent.id}
        placeholder="Reply…"
        autoFocus
        onSent={(m) => setReplies((r) => upsert(r, m))}
      />
    </SidePanel>
  );
}
