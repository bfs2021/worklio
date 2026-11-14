"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { api, auth, freshToken, WS_URL, type ConnectionStatus, type RealtimeEvent } from "@/lib/api";

/** Close codes sent by the server (see backend/app/realtime). */
const CLOSE_POLICY = 1008; // auth frame missing/invalid
const CLOSE_TOKEN_EXPIRED = 4001;
const CLOSE_SESSION_REVOKED = 4003;

/**
 * One WebSocket per tab, auto-reconnecting, with a heartbeat that keeps presence alive.
 *
 * The JWT never goes in the URL: the socket connects bare and sends `{type: "auth", token}`
 * as its first frame. Returns the connection `status`. After a reconnect (laptop sleep,
 * Wi-Fi blip, server restart) the handler receives a `{ type: "resync" }` event so consumers
 * can refetch whatever they missed while the socket was down (the server may send one too).
 */
export function useRealtime(onEvent: (e: RealtimeEvent) => void) {
  const handler = useRef(onEvent);
  const router = useRouter();
  const routerRef = useRef(router);
  const socket = useRef<WebSocket | null>(null);
  /** Public channels being watched without membership; re-subscribed after every reconnect. */
  const peeks = useRef(new Set<string>());
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    handler.current = onEvent;
    routerRef.current = router;
  });

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let hasConnected = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * When an admin deactivates/removes me from ONE workspace the server sends
     * `workspace.access_revoked` and then closes my sockets with CLOSE_SESSION_REVOKED so they
     * resubscribe without that workspace. That close must reconnect, not sign me out everywhere.
     */
    let accessRevokedAt = 0;

    const goToLogin = () => {
      closed = true;
      auth.clear();
      routerRef.current.replace("/login");
    };

    const dispatch = (e: RealtimeEvent) => {
      try {
        handler.current(e);
      } catch (err) {
        // A throwing consumer must never take the socket down with it.
        console.error("Realtime handler failed", err);
      }
    };

    const scheduleReconnect = () => {
      if (closed || retryTimer) return;
      retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
    };

    /** The server rejected or expired our token: is the stored one still good? */
    const verifyTokenThenReconnect = () => {
      if (!auth.get()) return goToLogin();
      api("/auth/me")
        .then(() => scheduleReconnect())
        .catch((err: unknown) => {
          // api() clears the token on 401; anything else (network) just retries.
          if (!auth.get() || (err as { status?: number }).status === 401) goToLogin();
          else scheduleReconnect();
        });
    };

    async function connect() {
      retryTimer = undefined;
      const token = await freshToken();
      if (closed) return;
      if (!token) return goToLogin();
      const ws = new WebSocket(`${WS_URL}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
        for (const cid of peeks.current) ws.send(JSON.stringify({ type: "subscribe", channel_id: cid }));
        retry = 0;
        setStatus("open");
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "ping" }));
          // Keep the server-side session in sync if the stored token was replaced (e.g. re-login).
          const current = auth.get();
          if (current && current !== token) ws.send(JSON.stringify({ type: "auth", token: current }));
        }, 30_000);
        if (hasConnected) dispatch({ type: "resync" });
        hasConnected = true;
      };
      ws.onmessage = (m) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(m.data);
        } catch {
          return;
        }
        if (event.type === "workspace.access_revoked") accessRevokedAt = Date.now();
        dispatch(event);
      };
      ws.onclose = (ev) => {
        clearInterval(heartbeat);
        if (socket.current === ws) socket.current = null;
        if (closed) return;
        if (ev.code === CLOSE_SESSION_REVOKED && Date.now() - accessRevokedAt > 15_000) return goToLogin();
        setStatus(hasConnected ? "reconnecting" : "connecting");
        if (ev.code === CLOSE_TOKEN_EXPIRED || ev.code === CLOSE_POLICY) verifyTokenThenReconnect();
        else scheduleReconnect();
      };
    }

    // Back online, or the tab woke up: don't sit out the remaining backoff.
    const reconnectNow = () => {
      if (closed || !retryTimer) return;
      clearTimeout(retryTimer);
      retry = 0;
      connect();
    };
    const onVisible = () => document.visibilityState === "visible" && reconnectNow();
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);

    connect();

    return () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      socket.current?.close();
    };
  }, []);

  const send = (data: object) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  return {
    status,
    /** Write a raw client→server frame (no-op while disconnected). */
    send,
    sendTyping: (channelId: string) => send({ type: "typing", channel_id: channelId }),
    /** Watch a public channel live without joining it. */
    subscribeChannel: (channelId: string) => {
      peeks.current.add(channelId);
      send({ type: "subscribe", channel_id: channelId });
    },
    unsubscribeChannel: (channelId: string) => {
      if (!peeks.current.delete(channelId)) return;
      send({ type: "unsubscribe", channel_id: channelId });
    },
  };
}
