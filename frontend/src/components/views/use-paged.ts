"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Page } from "@/lib/productivity";
import { errorMessage } from "@/lib/toast";

type State<T, P> = {
  key: string;
  items: T[];
  cursor: string | null;
  /** The first page's raw response (for extras such as `unread_count`). */
  first: P | null;
  /** First-page error (nothing to show). */
  error: string;
  /** A (re)load of the first page is running with nothing usable on screen. */
  loading: boolean;
  loadingMore: boolean;
  moreError: string;
};

export type Paged<T, P> = {
  /** null while the first page for the current key is loading (or failed). */
  items: T[] | null;
  first: P | null;
  error: string;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string;
  loadMore: () => void;
  /** Refetch the first page. `soft` keeps the current items on screen while it loads. */
  reload: (soft?: boolean) => void;
  setItems: (fn: (items: T[]) => T[]) => void;
  setFirst: (fn: (first: P) => P) => void;
};

/**
 * Cursor pagination keyed by `key` (change the key to reset, e.g. on a tab/filter switch).
 * All state updates happen in promise callbacks or event handlers, never synchronously in effects.
 */
export function usePaged<T, P extends Page<T> = Page<T>>(
  key: string,
  fetchPage: (cursor: string | null) => Promise<P>,
  getKey: (item: T) => string,
): Paged<T, P> {
  const [state, setState] = useState<State<T, P>>({
    key: "",
    items: [],
    cursor: null,
    first: null,
    error: "",
    loading: true,
    loadingMore: false,
    moreError: "",
  });
  const [attempt, setAttempt] = useState(0);
  const fetchRef = useRef(fetchPage);
  const keyFn = useRef(getKey);
  const stateRef = useRef(state);
  const busy = useRef(false);
  useEffect(() => {
    fetchRef.current = fetchPage;
    keyFn.current = getKey;
    stateRef.current = state;
  });

  useEffect(() => {
    let live = true;
    fetchRef
      .current(null)
      .then((p) => {
        if (!live) return;
        setState({
          key,
          items: p.items,
          cursor: p.next_cursor,
          first: p,
          error: "",
          loading: false,
          loadingMore: false,
          moreError: "",
        });
      })
      .catch((err) => {
        if (!live) return;
        setState((s) => ({
          ...(s.key === key ? s : { ...s, items: [], cursor: null, first: null }),
          key,
          // A failed soft refresh keeps what's on screen; only a cold load shows the error.
          error: s.key === key && !s.loading ? "" : errorMessage(err, "Something went wrong"),
          loading: false,
        }));
      });
    return () => {
      live = false;
    };
  }, [key, attempt]);

  const current = state.key === key;

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (busy.current || s.key !== key || !s.cursor) return;
    busy.current = true;
    setState((x) => ({ ...x, loadingMore: true, moreError: "" }));
    fetchRef
      .current(s.cursor)
      .then((p) => {
        setState((x) => {
          if (x.key !== key) return x;
          const seen = new Set(x.items.map((i) => keyFn.current(i)));
          return {
            ...x,
            items: [...x.items, ...p.items.filter((i) => !seen.has(keyFn.current(i)))],
            cursor: p.next_cursor,
            loadingMore: false,
          };
        });
      })
      .catch((err) => setState((x) => ({ ...x, loadingMore: false, moreError: errorMessage(err) })))
      .finally(() => {
        busy.current = false;
      });
  }, [key]);

  const reload = useCallback((soft = false) => {
    if (!soft) setState((x) => ({ ...x, key: "", error: "", loading: true }));
    setAttempt((n) => n + 1);
  }, []);

  const setItems = useCallback(
    (fn: (items: T[]) => T[]) => setState((x) => (x.key === key ? { ...x, items: fn(x.items) } : x)),
    [key],
  );
  const setFirst = useCallback(
    (fn: (first: P) => P) => setState((x) => (x.key === key && x.first ? { ...x, first: fn(x.first) } : x)),
    [key],
  );

  return {
    items: current && !state.loading && !state.error ? state.items : null,
    first: current ? state.first : null,
    error: current ? state.error : "",
    hasMore: current && !!state.cursor,
    loadingMore: current && state.loadingMore,
    moreError: current ? state.moreError : "",
    loadMore,
    reload,
    setItems,
    setFirst,
  };
}
