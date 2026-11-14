"use client";

import { Hash, Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { describeSearch, highlightTerms, parseSearch, SearchFilterBar } from "@/components/messaging/search-filters";
import { useGroupsById } from "@/components/messaging/use-groups";
import { StatusEmoji } from "@/components/profile/status-emoji";
import { useWorkspace } from "@/components/workspace/provider";
import { api, type Message } from "@/lib/api";
import { formatMessage } from "@/lib/format";
import { dayLabel, media, messagePath, timeLabel } from "@/lib/messages";

import { SidePanel } from "./side-panel";
import { UserAvatar } from "./user-avatar";

const SEARCH_PAGE = 30;

export function SearchPanel({ query, onClose }: { query: string; onClose: () => void }) {
  const ws = useWorkspace();
  const [results, setResults] = useState<Message[] | null>(null);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchUrl = (offset: number) =>
    `/workspaces/${ws.workspaceId}/search?q=${encodeURIComponent(query)}&limit=${SEARCH_PAGE}&offset=${offset}`;

  useEffect(() => {
    let live = true;
    api<Message[]>(`/workspaces/${ws.workspaceId}/search?q=${encodeURIComponent(query)}&limit=${SEARCH_PAGE}`)
      .then((r) => {
        if (!live) return;
        setResults(r);
        setHasMore(r.length === SEARCH_PAGE);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ws.workspaceId, query]);

  const showMore = async () => {
    if (!results || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api<Message[]>(searchUrl(results.length));
      setResults((r) => [...(r ?? []), ...page.filter((m) => !r?.some((x) => x.id === m.id))]);
      setHasMore(page.length === SEARCH_PAGE && results.length + page.length < 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const terms = highlightTerms(parseSearch(query));
  const pretty = describeSearch(query, {
    user: (id) => ws.memberById[id]?.full_name ?? "someone",
    channel: (id) => {
      const c = ws.channels.find((x) => x.id === id);
      return c ? ws.channelLabel(c) : "conversation";
    },
  });

  return (
    <SidePanel title="Search" subtitle={`“${pretty}”`} onClose={onClose}>
      <SearchFilterBar query={query} onChange={(q) => q.trim() && ws.setSearchQuery(q)} />
      <div className="flex-1 overflow-y-auto">
        {!results && !error && <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />}
        {error && <p className="p-4 text-sm text-destructive">{error}</p>}
        {results && (
          <p className="border-b px-4 py-2 text-xs text-muted-foreground">
            {results.length}
            {hasMore ? "+" : ""} {results.length === 1 && !hasMore ? "result" : "results"}
          </p>
        )}
        {results?.length === 0 && (
          <div className="p-8 text-center">
            <p className="font-bold">No results</p>
            <p className="text-sm text-muted-foreground">Try different words, fewer filters, or check spelling.</p>
          </div>
        )}
        {results?.map((m) => <ResultRow key={m.id} message={m} highlight={terms} />)}
        {hasMore && (
          <div className="p-3 text-center">
            <button
              onClick={showMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-semibold hover:bg-muted disabled:opacity-60"
            >
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              Show more results
            </button>
          </div>
        )}
      </div>
    </SidePanel>
  );
}

export function ResultRow({ message: m, highlight }: { message: Message; highlight?: string[] }) {
  const ws = useWorkspace();
  const groups = useGroupsById(ws.workspaceId);
  const author = ws.memberById[m.author_id]?.full_name ?? "Unknown";
  const channel = ws.channels.find((c) => c.id === m.channel_id);
  return (
    <Link
      href={messagePath(m)}
      scroll={false}
      onClick={() => {
        ws.setSidebarOpen(false);
        // Below lg the results cover the conversation: get out of the way so the jump is visible.
        if (media.overlayPanels()) ws.setSearchQuery(null);
      }}
      className="block border-b px-4 py-3 hover:bg-muted/60"
    >
      <div className="mb-1 flex items-center gap-1 text-xs font-bold text-muted-foreground">
        {channel?.kind === "dm" ? null : channel?.kind === "private" ? <Lock className="size-3" /> : <Hash className="size-3" />}
        {channel ? ws.channelLabel(channel) : "conversation"}
        {m.parent_id && <span className="font-normal">· thread reply</span>}
      </div>
      <div className="flex gap-2.5">
        <UserAvatar id={m.author_id} name={author} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="truncate text-msg font-black">{author}</span>
              <StatusEmoji userId={m.author_id} className="self-center text-[13px]" />
            </span>
            <span className="text-xs text-muted-foreground">
              {dayLabel(m.created_at)} at {timeLabel(m.created_at)}
            </span>
          </div>
          <div className="line-clamp-4 text-msg break-words whitespace-pre-wrap">
            {m.body ? formatMessage(m.body, { names: ws.memberById, meId: ws.me?.id, groups, highlight }) : <em className="text-muted-foreground">Shared a file</em>}
          </div>
        </div>
      </div>
    </Link>
  );
}
