"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useWorkspace, useWorkspaceEvents } from "@/components/workspace/provider";
import { asCanvasEvent, canvasApi, type CanvasComment } from "@/lib/canvas";
import { errorMessage, toast } from "@/lib/toast";

export type CommentThread = {
  id: string;
  root: CanvasComment;
  replies: CanvasComment[];
  resolved: boolean;
  anchorId: string | null;
  quote: string | null;
  /** Latest activity, for sorting. */
  lastAt: string;
};

export type CommentsState = {
  status: "loading" | "ready" | "error";
  error: string;
  threads: CommentThread[];
  /** anchor id -> thread, for clicks on highlighted text. */
  byAnchor: Record<string, CommentThread>;
  retry: () => void;
  add: (body: { body: string; anchor_id?: string | null; quote?: string | null; thread_id?: string | null }) => Promise<CanvasComment>;
  edit: (id: string, body: string) => Promise<void>;
  setResolved: (threadId: string, resolved: boolean) => Promise<void>;
  remove: (comment: CanvasComment) => Promise<void>;
};

let tempSeq = 0;

function buildThreads(comments: CanvasComment[]): CommentThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const threads = new Map<string, CommentThread>();
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const c of sorted) {
    const rootId = c.thread_id && byId.has(c.thread_id) ? c.thread_id : c.id;
    if (rootId === c.id) {
      threads.set(c.id, {
        id: c.id,
        root: c,
        replies: [],
        resolved: c.resolved,
        anchorId: c.anchor_id,
        quote: c.quote,
        lastAt: c.created_at,
      });
    }
  }
  for (const c of sorted) {
    const rootId = c.thread_id && byId.has(c.thread_id) ? c.thread_id : c.id;
    if (rootId === c.id) continue;
    const t = threads.get(rootId);
    if (!t) continue;
    t.replies.push(c);
    if (c.created_at > t.lastAt) t.lastAt = c.created_at;
  }
  return [...threads.values()];
}

/** Canvas comments with live refresh and optimistic mutations (rolled back with a toast on failure). */
export function useCanvasComments(canvasId: string): CommentsState {
  const { me } = useWorkspace();
  const [comments, setComments] = useState<CanvasComment[]>([]);
  const [status, setStatus] = useState<CommentsState["status"]>("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const fetchSeq = useRef(0);
  const refetchTimer = useRef<number | undefined>(undefined);

  function load() {
    const seq = ++fetchSeq.current;
    return canvasApi.comments(canvasId).then(
      (list) => {
        if (seq !== fetchSeq.current) return;
        setComments(list);
        setStatus("ready");
        setError("");
      },
      (err) => {
        if (seq !== fetchSeq.current) return;
        setError(errorMessage(err, "Couldn't load comments"));
        setStatus((s) => (s === "ready" ? s : "error"));
      },
    );
  }

  useEffect(() => {
    let live = true;
    const seq = ++fetchSeq.current;
    canvasApi.comments(canvasId).then(
      (list) => {
        if (!live || seq !== fetchSeq.current) return;
        setComments(list);
        setStatus("ready");
        setError("");
      },
      (err) => {
        if (!live || seq !== fetchSeq.current) return;
        setError(errorMessage(err, "Couldn't load comments"));
        setStatus("error");
      },
    );
    return () => {
      live = false;
    };
  }, [canvasId, attempt]);

  useEffect(() => () => window.clearTimeout(refetchTimer.current), []);

  useWorkspaceEvents((raw) => {
    if (raw.type === "resync") {
      void load();
      return;
    }
    const e = asCanvasEvent(raw);
    if (e?.type !== "canvas.comments.updated" || e.canvas_id !== canvasId) return;
    // Bursts (resolve + reply) collapse into one fetch.
    window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => void load(), 150);
  });

  const threads = useMemo(() => buildThreads(comments), [comments]);
  const byAnchor = useMemo(() => {
    const out: Record<string, CommentThread> = {};
    for (const t of threads) if (t.anchorId) out[t.anchorId] = t;
    return out;
  }, [threads]);

  async function add(body: Parameters<CommentsState["add"]>[0]) {
    const tempId = `temp-${++tempSeq}`;
    const optimistic: CanvasComment = {
      id: tempId,
      canvas_id: canvasId,
      thread_id: body.thread_id ?? tempId,
      anchor_id: body.anchor_id ?? null,
      body: body.body,
      author_id: me?.id ?? "",
      created_at: new Date().toISOString(),
      resolved: false,
      quote: body.quote ?? null,
    };
    setComments((cs) => [...cs, optimistic]);
    // Invalidate in-flight fetches so they can't drop the optimistic row.
    fetchSeq.current++;
    try {
      const saved = await canvasApi.addComment(canvasId, body);
      setComments((cs) => [...cs.filter((c) => c.id !== tempId && c.id !== saved.id), saved]);
      return saved;
    } catch (err) {
      setComments((cs) => cs.filter((c) => c.id !== tempId));
      toast.error(errorMessage(err, "Couldn't post the comment"));
      throw err;
    }
  }

  async function edit(id: string, body: string) {
    const prev = comments.find((c) => c.id === id);
    if (!prev) return;
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, body } : c)));
    fetchSeq.current++;
    try {
      const saved = await canvasApi.updateComment(id, { body });
      setComments((cs) => cs.map((c) => (c.id === id ? saved : c)));
    } catch (err) {
      setComments((cs) => cs.map((c) => (c.id === id ? prev : c)));
      toast.error(errorMessage(err, "Couldn't edit the comment"));
      throw err;
    }
  }

  async function setResolved(threadId: string, resolved: boolean) {
    const prev = comments.find((c) => c.id === threadId);
    if (!prev) return;
    setComments((cs) => cs.map((c) => (c.id === threadId ? { ...c, resolved } : c)));
    fetchSeq.current++;
    try {
      const saved = await canvasApi.updateComment(threadId, { resolved });
      setComments((cs) => cs.map((c) => (c.id === threadId ? saved : c)));
    } catch (err) {
      setComments((cs) => cs.map((c) => (c.id === threadId ? prev : c)));
      toast.error(errorMessage(err, resolved ? "Couldn't resolve the thread" : "Couldn't reopen the thread"));
      throw err;
    }
  }

  async function remove(comment: CanvasComment) {
    const snapshot = comments;
    const isRoot = comment.thread_id === comment.id || !comment.thread_id;
    setComments((cs) => cs.filter((c) => c.id !== comment.id && !(isRoot && c.thread_id === comment.id)));
    fetchSeq.current++;
    try {
      await canvasApi.deleteComment(comment.id);
    } catch (err) {
      setComments(snapshot);
      toast.error(errorMessage(err, "Couldn't delete the comment"));
      throw err;
    }
  }

  return {
    status,
    error,
    threads,
    byAnchor,
    retry: () => {
      setStatus("loading");
      setAttempt((n) => n + 1);
    },
    add,
    edit,
    setResolved,
    remove,
  };
}
