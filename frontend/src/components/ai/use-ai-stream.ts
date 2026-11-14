"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { streamAI, type AICitation, type AIErrorCode } from "@/lib/ai";

export type AIStreamState = {
  text: string;
  /** Latest progress line ("Searching messages…"); cleared once text starts flowing. */
  status: string | null;
  citations: AICitation[];
  error: { code: AIErrorCode; message: string } | null;
  streaming: boolean;
  /** The stream ended (done, error or stopped). */
  finished: boolean;
  stopped: boolean;
  conversationId: string | null;
};

export type AIStreamResult = Omit<AIStreamState, "streaming" | "finished" | "status">;

const IDLE: AIStreamState = {
  text: "",
  status: null,
  citations: [],
  error: null,
  streaming: false,
  finished: false,
  stopped: false,
  conversationId: null,
};

/**
 * Drives one streaming AI request. Text deltas are batched to one render per frame.
 *
 * `start()` is for event handlers. `run()` starts without a synchronous reset, for effects in
 * components created with `useAIStream(true)` (they render as streaming from the first frame).
 * A new start aborts the previous request; unmounting aborts too.
 */
export function useAIStream(startStreaming = false) {
  const [state, setState] = useState<AIStreamState>(startStreaming ? { ...IDLE, streaming: true } : IDLE);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  const run = useCallback(async (path: string, body: unknown): Promise<AIStreamResult> => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const acc: AIStreamResult & { status: string | null } = {
      text: "",
      status: null,
      citations: [],
      error: null,
      stopped: false,
      conversationId: null,
    };
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (ctrl.current !== c) return;
      setState((s) => ({ ...s, text: acc.text, status: acc.status, citations: acc.citations, streaming: true }));
    };
    const schedule = () => {
      if (!frame) frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(flush) : (setTimeout(flush, 16) as unknown as number);
    };

    await streamAI(
      path,
      body,
      (e) => {
        if (e.type === "text") {
          acc.text += e.delta;
          acc.status = null;
        } else if (e.type === "status") acc.status = e.text;
        else if (e.type === "citations") acc.citations = [...acc.citations.filter((x) => !e.items.some((y) => y.n === x.n)), ...e.items].sort((a, b) => a.n - b.n);
        else if (e.type === "done") acc.conversationId = e.conversation_id ?? null;
        else if (e.type === "error") acc.error = { code: e.code, message: e.message };
        schedule();
      },
      c.signal,
    );
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    acc.stopped = c.signal.aborted;
    if (ctrl.current === c) {
      ctrl.current = null;
      setState({ ...acc, status: null, streaming: false, finished: true });
    }
    return { text: acc.text, citations: acc.citations, error: acc.error, stopped: acc.stopped, conversationId: acc.conversationId };
  }, []);

  const start = useCallback(
    (path: string, body: unknown) => {
      setState({ ...IDLE, streaming: true });
      return run(path, body);
    },
    [run],
  );

  const stop = useCallback(() => ctrl.current?.abort(), []);

  /** Abort and clear. `pending` keeps it in the streaming state (call `run` right after, e.g. from an effect). */
  const reset = useCallback((pending = false) => {
    ctrl.current?.abort();
    ctrl.current = null;
    setState(pending ? { ...IDLE, streaming: true } : IDLE);
  }, []);

  return { ...state, start, run, stop, reset };
}
