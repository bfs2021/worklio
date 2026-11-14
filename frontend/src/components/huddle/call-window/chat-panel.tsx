"use client";

import type { Room } from "livekit-client";
import { MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { api, type Message } from "@/lib/api";
import { applyMessageEvent, upsert } from "@/lib/messages";
import { errorMessage } from "@/lib/toast";

import { getCallRoomData } from "./room-data";

export type CallChat = {
  replies: Message[];
  loading: boolean;
  error: string;
  retry: () => void;
  add: (m: Message) => void;
  /** New messages from others that arrived while the chat wasn't visible. */
  unread: number;
  /** The latest such message, for a preview toast (cleared after a few seconds). */
  preview: Message | null;
  dismissPreview: () => void;
};

const PREVIEW_MS = 6000;

/**
 * The call card's thread (GET /messages/{id}/replies), kept live from realtime events for as
 * long as I'm in the call, whether or not the chat panel is open. `visible` says whether the
 * chat is on screen right now: messages arriving while it isn't count as unread and pop a preview.
 */
export function useCallChat(channelId: string, messageId: string | null, visible: boolean, windowOpen: boolean): CallChat {
  const { me } = useWorkspace();
  const [state, setState] = useState<{ key: string | null; replies: Message[]; loading: boolean; error: string }>({
    key: null,
    replies: [],
    loading: true,
    error: "",
  });
  const [attempt, setAttempt] = useState(0);
  const [unread, setUnread] = useState(0);
  const [preview, setPreview] = useState<Message | null>(null);

  // Mirrors for the realtime handler (written in effects only).
  const visibleRef = useRef(visible);
  const windowOpenRef = useRef(windowOpen);
  useEffect(() => {
    visibleRef.current = visible;
    windowOpenRef.current = windowOpen;
  });

  const fetchReplies = useCallback(() => api<Message[]>(`/messages/${messageId}/replies`), [messageId]);

  useEffect(() => {
    if (!messageId) return;
    let live = true;
    fetchReplies()
      .then((r) => live && setState({ key: messageId, replies: r, loading: false, error: "" }))
      .catch((err) => live && setState((s) => ({ ...s, key: messageId, loading: false, error: errorMessage(err) })));
    return () => {
      live = false;
    };
  }, [messageId, fetchReplies, attempt]);

  useWorkspaceEvents((e) => {
    if (!messageId) return;
    if (e.type === "resync") {
      fetchReplies().then((r) => setState((s) => ({ ...s, replies: r })), () => {});
      return;
    }
    setState((s) => {
      const replies = applyMessageEvent(s.replies, e, { channelId, parentId: messageId });
      return replies === s.replies ? s : { ...s, replies };
    });
    if (e.type === "message.created" && e.message.parent_id === messageId && e.message.author_id !== me?.id) {
      if (!visibleRef.current) {
        setUnread((n) => n + 1);
        if (windowOpenRef.current) setPreview(e.message);
      }
    }
  });

  // Seen: reset the badge once the chat is on screen (adjusting state while rendering).
  if (visible && (unread || preview)) {
    setUnread(0);
    setPreview(null);
  }

  useEffect(() => {
    if (!preview) return;
    const id = window.setTimeout(() => setPreview(null), PREVIEW_MS);
    return () => window.clearTimeout(id);
  }, [preview]);

  const current = state.key === messageId;
  return {
    replies: current ? state.replies : [],
    loading: !current || state.loading,
    error: current ? state.error : "",
    retry: () => {
      setState((s) => ({ ...s, loading: true, error: "" }));
      setAttempt((n) => n + 1);
    },
    add: (m) => setState((s) => ({ ...s, replies: upsert(s.replies, m) })),
    unread,
    preview,
    dismissPreview: () => setPreview(null),
  };
}

/** In-call chat that stays with the call's thread afterwards. */
export function ChatPanel({
  channelId,
  messageId,
  chat,
  room,
  typingIds,
}: {
  channelId: string;
  messageId: string;
  chat: CallChat;
  room: Room | null;
  typingIds: string[];
}) {
  const { memberById } = useWorkspace();
  const { replies, loading, error, retry, add } = chat;
  const names = typingIds.map((id) => memberById[id]?.full_name.split(" ")[0] ?? "Someone");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div className="border-b border-red-400/20 bg-red-500/10 px-4 py-2 text-xs text-red-200">
          Couldn&apos;t load messages: {error}.{" "}
          <button type="button" onClick={retry} className="rounded font-bold underline outline-none focus-visible:ring-2 focus-visible:ring-white/60">
            Try again
          </button>
        </div>
      )}
      <MessageList
        messages={replies}
        loading={loading}
        header={
          !loading && !replies.length && !error ? (
            <div className="flex flex-col items-center gap-2 px-6 pt-12 pb-4 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400/20 to-indigo-400/20 ring-1 ring-white/10">
                <MessagesSquare className="size-5 text-white/85" aria-hidden />
              </span>
              <p className="text-sm font-semibold text-white">Chat with everyone in the call</p>
              <p className="max-w-[250px] text-xs text-white/55">
                Share links, files and quick thoughts without interrupting. Everything stays in this call&apos;s thread.
              </p>
            </div>
          ) : undefined
        }
      />
      <div className="h-5 shrink-0 px-4 text-[11.5px] text-white/55" aria-live="polite">
        {names.length > 0 && (
          <span className="inline-flex items-center gap-1.5 animate-in fade-in-0 duration-200">
            <TypingDots />
            <span>
              <strong className="font-semibold text-white/80">{names.slice(0, 3).join(", ")}</strong>
              {names.length > 3 ? ` and ${names.length - 3} more` : ""} {names.length === 1 ? "is" : "are"} typing…
            </span>
          </span>
        )}
      </div>
      <div
        onInput={() => room && getCallRoomData(room).sendChatTyping()}
        className="shrink-0"
      >
        <Composer
          channelId={channelId}
          parentId={messageId}
          placeholder="Message everyone in the call…"
          onSent={(m) => {
            add(m);
            if (room) getCallRoomData(room).stopChatTyping();
          }}
        />
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 animate-bounce rounded-full bg-white/60 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}
