"use client";

import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { useSyncExternalStore } from "react";

/** Reactions anyone can send. Incoming emoji outside this list are ignored. */
export const CALL_REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮", "🔥", "🙌"] as const;
const ALLOWED = new Set<string>(CALL_REACTIONS);

const REACTION_TTL_MS = 3200;
const MAX_REACTIONS = 40;
const SEND_GAP_MS = 180;

export const TOPIC_REACTIONS = "reactions";
export const TOPIC_HAND = "hand";

export type FloatingReaction = {
  id: number;
  emoji: string;
  identity: string;
  /** Horizontal start position, 0–1. */
  x: number;
  /** Sideways drift in px, for a less mechanical float. */
  drift: number;
};

export type CallSignalsSnapshot = {
  reactions: FloatingReaction[];
  /** identity -> time the hand went up (ms). */
  hands: Readonly<Record<string, number>>;
};

const EMPTY: CallSignalsSnapshot = Object.freeze({ reactions: [], hands: Object.freeze({}) }) as CallSignalsSnapshot;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let nextId = 1;

/**
 * Per-room store for ephemeral call signals carried on LiveKit data messages:
 * emoji reactions (topic "reactions", `{emoji}`) and raised hands (topic "hand", `{raised}`).
 * Snapshots are immutable and only replaced when something changes.
 */
class CallSignals {
  private listeners = new Set<() => void>();
  private snapshot: CallSignalsSnapshot = EMPTY;
  private lastSent = 0;
  private disposed = false;

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

  private set(next: CallSignalsSnapshot) {
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

  private addReaction(emoji: string, identity: string) {
    const r: FloatingReaction = {
      id: nextId++,
      emoji,
      identity,
      x: 0.12 + Math.random() * 0.76,
      drift: Math.round((Math.random() - 0.5) * 80),
    };
    this.set({ ...this.snapshot, reactions: [...this.snapshot.reactions, r].slice(-MAX_REACTIONS) });
    window.setTimeout(() => {
      if (!this.snapshot.reactions.some((x) => x.id === r.id)) return;
      this.set({ ...this.snapshot, reactions: this.snapshot.reactions.filter((x) => x.id !== r.id) });
    }, REACTION_TTL_MS);
  }

  private setHandFor(identity: string, raised: boolean) {
    const has = identity in this.snapshot.hands;
    if (raised === has) return;
    const hands = { ...this.snapshot.hands };
    if (raised) hands[identity] = Date.now();
    else delete hands[identity];
    this.set({ ...this.snapshot, hands });
  }

  private onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
    if (!participant || (topic !== TOPIC_REACTIONS && topic !== TOPIC_HAND)) return;
    let data: unknown;
    try {
      data = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (topic === TOPIC_REACTIONS) {
      const emoji = (data as { emoji?: unknown }).emoji;
      if (typeof emoji === "string" && ALLOWED.has(emoji)) this.addReaction(emoji, participant.identity);
    } else {
      const raised = (data as { raised?: unknown }).raised;
      if (typeof raised === "boolean") this.setHandFor(participant.identity, raised);
    }
  };

  /** A newcomer doesn't know my hand is up; tell just them. */
  private onJoin = (p: RemoteParticipant) => {
    if (this.myId in this.snapshot.hands) this.publish(TOPIC_HAND, { raised: true }, [p.identity]);
  };

  private onLeave = (p: RemoteParticipant) => this.setHandFor(p.identity, false);

  /** Broadcast an emoji reaction (and show it locally). Rate-limited to avoid floods. */
  react(emoji: string) {
    if (!ALLOWED.has(emoji) || this.disposed) return;
    const now = Date.now();
    if (now - this.lastSent < SEND_GAP_MS) return;
    this.lastSent = now;
    this.addReaction(emoji, this.myId);
    this.publish(TOPIC_REACTIONS, { emoji });
  }

  setHand(raised: boolean) {
    if (this.disposed) return;
    this.setHandFor(this.myId, raised);
    this.publish(TOPIC_HAND, { raised });
  }

  isHandRaised() {
    return this.myId in this.snapshot.hands;
  }

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.room.off(RoomEvent.DataReceived, this.onData);
    this.room.off(RoomEvent.ParticipantConnected, this.onJoin);
    this.room.off(RoomEvent.ParticipantDisconnected, this.onLeave);
    this.room.off(RoomEvent.Disconnected, this.dispose);
    this.set(EMPTY);
    this.listeners.clear();
  };
}

const cache = new WeakMap<Room, CallSignals>();

/** The signals store for a room (created once per Room, disposed when it disconnects). */
export function getCallSignals(room: Room): CallSignals {
  let s = cache.get(room);
  if (!s) {
    s = new CallSignals(room);
    cache.set(room, s);
  }
  return s;
}

const IDLE = { subscribe: () => () => {}, getSnapshot: () => EMPTY };

/** Live reactions + raised hands for the room (stable empty snapshot when there's no room). */
export function useCallSignals(room: Room | null): CallSignalsSnapshot {
  const store = room ? getCallSignals(room) : IDLE;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, IDLE.getSnapshot);
}

export type { CallSignals };
