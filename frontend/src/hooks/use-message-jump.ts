"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import type { Message } from "@/lib/api";
import { toast } from "@/lib/toast";

const HIGHLIGHT_MS = 3500;

/**
 * "Jump to message" for a channel timeline, driven by the URL built by `messagePath()`:
 *   ?msg=<top-level id>[&thread=<parent id>&reply=<reply id>]
 *
 * If the message isn't loaded, loads the window of history around it in one request (any age),
 * opens its thread for replies, and returns the ids to highlight. The params are dropped from the URL after
 * a few seconds, which fades the highlight out and lets the same link be followed again.
 *
 * Must be used under <Suspense> (it reads search params).
 */
export function useMessageJump({
  messages,
  loading,
  loadAround,
  openThread,
}: {
  messages: Message[];
  loading: boolean;
  /** Replace the timeline with the messages around `id` (rejects if it doesn't exist). */
  loadAround: (id: string) => Promise<void>;
  openThread: (parent: Message) => void;
}): { highlightId: string | null; threadHighlightId: string | null } {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const msg = params.get("msg");
  const thread = params.get("thread");
  const reply = params.get("reply");
  const key = msg ? params.toString() : null;
  const target = msg ? messages.find((m) => m.id === msg) : undefined;

  const handled = useRef<string | null>(null);
  const attempted = useRef<string | null>(null);
  const inFlight = useRef(false);
  const loadRef = useRef(loadAround);
  const openRef = useRef(openThread);
  useEffect(() => {
    loadRef.current = loadAround;
    openRef.current = openThread;
  });

  useEffect(() => {
    if (!key || loading || handled.current === key) return;
    const clear = () => router.replace(pathname, { scroll: false });

    if (target) {
      handled.current = key;
      if (thread && thread === target.id) openRef.current(target);
      return;
    }
    if (inFlight.current) return;
    if (attempted.current !== key && msg) {
      attempted.current = key;
      inFlight.current = true;
      loadRef
        .current(msg)
        .catch(() => {
          handled.current = key;
          toast.info("That message is no longer available");
          clear();
        })
        .finally(() => {
          inFlight.current = false;
        });
      return;
    }
    handled.current = key;
    toast.info("That message is no longer available");
    clear();
  }, [key, msg, loading, target, thread, messages.length, router, pathname]);

  // Fade the highlight out by dropping the params once the message has been shown.
  const found = !!target;
  useEffect(() => {
    if (!key || !found) return;
    const t = setTimeout(() => router.replace(pathname, { scroll: false }), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [key, found, router, pathname]);

  return {
    highlightId: target ? target.id : null,
    threadHighlightId: target && thread === target.id ? reply : null,
  };
}
