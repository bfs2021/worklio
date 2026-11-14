"use client";

import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { useSyncExternalStore } from "react";

import type { AnnotationOp } from "@/components/annotate";

/**
 * What the call stage shows. Each person picks their own; "Bring everyone" broadcasts a choice.
 * "screen" is chosen automatically when someone starts sharing.
 */
export type StageMode = "video" | "screen" | "whiteboard" | "board";

export const TOPIC_STAGE = "stage";
export const TOPIC_ANNOTATE = "annotate";
export const TOPIC_CHAT_TYPING = "chat-typing";

const STAGE_MODES = new Set<StageMode>(["video", "screen", "whiteboard", "board"]);
const TYPING_TTL_MS = 4500;
const TYPING_SEND_GAP_MS = 2500;
const PRESENT_TTL_MS = 12_000;
const MAX_LOG = 3000;
/** Ops replayed to someone who joins while I'm presenting. */
const LATE_JOIN_REPLAY = 400;

/** Someone asked everyone to look at a stage. */
export type Presentation = { id: number; identity: string; mode: StageMode; at: number };

export type CallRoomDataSnapshot = {
  presentation: Presentation | null;
  /** identity -> last "typing in the call chat" ping (ms). */
  chatTyping: Readonly<Record<string, number>>;
};

const EMPTY: CallRoomDataSnapshot = Object.freeze({
  presentation: null,
  chatTyping: Object.freeze({}),
}) as CallRoomDataSnapshot;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let nextPresentationId = 1;

function isOp(v: unknown): v is AnnotationOp {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string" && typeof o.id === "string";
}

/**
 * Per-room store for the call window's own LiveKit data messages (all reliable; no lossy
 * channels): stage presentations ("stage"), screen-share annotations ("annotate") and the
 * in-call chat typing indicator ("chat-typing").
 */
class CallRoomData {
  private listeners = new Set<() => void>();
  private snapshot: CallRoomDataSnapshot = EMPTY;
  private disposed = false;
  private lastTypingSent = 0;
  private typingTimer: number | undefined;
  private presentTimer: number | undefined;

  /** Annotations for the screen share identified by `annotateKey` ("identity:trackSid"). */
  private annotateKey = "";
  /** Latest version of each op by id (in-progress strokes are re-sent with the same id), in first-seen order. */
  private annotateLog = new Map<string, AnnotationOp>();
  private annotateSubs = new Set<(op: AnnotationOp) => void>();

  constructor(readonly room: Room) {
    room.on(RoomEvent.DataReceived, this.onData);
    room.on(RoomEvent.ParticipantConnected, this.onJoin);
    room.on(RoomEvent.ParticipantDisconnected, this.onLeave);
    room.on(RoomEvent.Disconnected, this.dispose);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(next: CallRoomDataSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((fn) => fn());
  }

  private get myId() {
    return this.room.localParticipant.identity;
  }

  private publish(topic: string, payload: object, to?: string[]) {
    if (this.disposed) return;
    void this.room.localParticipant
      .publishData(encoder.encode(JSON.stringify(payload)), { reliable: true, topic, destinationIdentities: to })
      .catch(() => {});
  }

  private onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (!participant || participant.identity === this.myId) return;
    if (topic !== TOPIC_STAGE && topic !== TOPIC_ANNOTATE && topic !== TOPIC_CHAT_TYPING) return;
    let data: unknown;
    try {
      data = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const d = data as Record<string, unknown>;

    if (topic === TOPIC_STAGE) {
      const mode = d.mode as StageMode;
      if (!STAGE_MODES.has(mode)) return;
      this.setPresentation({ id: nextPresentationId++, identity: participant.identity, mode, at: Date.now() });
      return;
    }

    if (topic === TOPIC_ANNOTATE) {
      const key = typeof d.k === "string" ? d.k : "";
      if (!key || !isOp(d.op)) return;
      this.useKey(key);
      this.log(d.op);
      this.annotateSubs.forEach((fn) => fn(d.op as AnnotationOp));
      return;
    }

    // chat typing
    if (d.typing === false) {
      if (!(participant.identity in this.snapshot.chatTyping)) return;
      const chatTyping = { ...this.snapshot.chatTyping };
      delete chatTyping[participant.identity];
      this.set({ ...this.snapshot, chatTyping });
      return;
    }
    this.set({ ...this.snapshot, chatTyping: { ...this.snapshot.chatTyping, [participant.identity]: Date.now() } });
    this.scheduleTypingPrune();
  };

  private onJoin = (p: RemoteParticipant) => {
    // If I'm presenting with annotations on screen, catch the newcomer up.
    if (!this.room.localParticipant.isScreenShareEnabled || !this.annotateLog.size) return;
    if (!this.annotateKey.startsWith(`${this.myId}:`)) return;
    for (const op of [...this.annotateLog.values()].slice(-LATE_JOIN_REPLAY)) {
      this.publish(TOPIC_ANNOTATE, { k: this.annotateKey, op }, [p.identity]);
    }
  };

  private onLeave = (p: RemoteParticipant) => {
    if (!(p.identity in this.snapshot.chatTyping)) return;
    const chatTyping = { ...this.snapshot.chatTyping };
    delete chatTyping[p.identity];
    this.set({ ...this.snapshot, chatTyping });
  };

  // --- Stage presentations ---

  private setPresentation(p: Presentation | null) {
    window.clearTimeout(this.presentTimer);
    this.set({ ...this.snapshot, presentation: p });
    if (p) this.presentTimer = window.setTimeout(() => this.dismissPresentation(p.id), PRESENT_TTL_MS);
  }

  /** Ask everyone in the call to switch their stage to `mode`. */
  present(mode: StageMode) {
    if (!STAGE_MODES.has(mode)) return;
    this.publish(TOPIC_STAGE, { mode });
  }

  dismissPresentation(id?: number) {
    const cur = this.snapshot.presentation;
    if (!cur || (id !== undefined && cur.id !== id)) return;
    window.clearTimeout(this.presentTimer);
    this.set({ ...this.snapshot, presentation: null });
  }

  // --- Annotations ---

  private useKey(key: string) {
    if (key === this.annotateKey) return;
    this.annotateKey = key;
    this.annotateLog = new Map();
  }

  private log(op: AnnotationOp) {
    if (op.kind === "clear") this.annotateLog = new Map();
    this.annotateLog.set(op.id, op);
    if (this.annotateLog.size > MAX_LOG) {
      const oldest = this.annotateLog.keys().next().value;
      if (oldest !== undefined) this.annotateLog.delete(oldest);
    }
  }

  /** Broadcast one of my annotation ops on the share `key`. */
  sendAnnotation(key: string, op: AnnotationOp) {
    this.useKey(key);
    this.log(op);
    this.publish(TOPIC_ANNOTATE, { k: key, op });
  }

  /**
   * Listen for other people's ops on the share `key`. Everything already drawn on that share
   * (including mine) is replayed first, so a remounted overlay picks up where it was.
   */
  subscribeAnnotations(key: string, fn: (op: AnnotationOp) => void) {
    this.useKey(key);
    for (const op of this.annotateLog.values()) fn(op);
    this.annotateSubs.add(fn);
    return () => {
      this.annotateSubs.delete(fn);
    };
  }

  // --- Chat typing ---

  private scheduleTypingPrune() {
    window.clearTimeout(this.typingTimer);
    const entries = Object.values(this.snapshot.chatTyping);
    if (!entries.length) return;
    const next = Math.min(...entries) + TYPING_TTL_MS - Date.now();
    this.typingTimer = window.setTimeout(() => {
      if (this.disposed) return;
      const now = Date.now();
      const kept = Object.entries(this.snapshot.chatTyping).filter(([, t]) => now - t < TYPING_TTL_MS);
      if (kept.length !== Object.keys(this.snapshot.chatTyping).length) {
        this.set({ ...this.snapshot, chatTyping: Object.fromEntries(kept) });
      }
      this.scheduleTypingPrune();
    }, Math.max(50, next));
  }

  /** Tell the call I'm typing in its chat (throttled). */
  sendChatTyping() {
    const now = Date.now();
    if (now - this.lastTypingSent < TYPING_SEND_GAP_MS) return;
    this.lastTypingSent = now;
    this.publish(TOPIC_CHAT_TYPING, { typing: true });
  }

  /** I sent (or cleared) my message: stop showing me as typing. */
  stopChatTyping() {
    if (!this.lastTypingSent) return;
    this.lastTypingSent = 0;
    this.publish(TOPIC_CHAT_TYPING, { typing: false });
  }

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.typingTimer);
    window.clearTimeout(this.presentTimer);
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantConnected, this.onJoin);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeave);
    this.room.off(RoomEvent.Disconnected, this.dispose);
    this.annotateSubs.clear();
    this.annotateLog = new Map();
    this.set(EMPTY);
    this.listeners.clear();
  };
}

const cache = new WeakMap<Room, CallRoomData>();

export function getCallRoomData(room: Room): CallRoomData {
  let s = cache.get(room);
  if (!s) {
    s = new CallRoomData(room);
    cache.set(room, s);
  }
  return s;
}

const IDLE = { subscribe: () => () => {}, getSnapshot: () => EMPTY };

export function useCallRoomData(room: Room | null): CallRoomDataSnapshot {
  const store = room ? getCallRoomData(room) : IDLE;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, IDLE.getSnapshot);
}

export type { CallRoomData };
