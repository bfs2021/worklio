/**
 * Yjs provider over Worklio's shared realtime WebSocket.
 *
 * Protocol (see lib/canvas.ts):
 *   - GET /canvases/{id}/state → full doc + server state vector; applied on start and on every resync.
 *   - `canvas.join` subscribes this socket to the canvas; the server answers `canvas.joined`.
 *   - Local doc updates are batched, merged and sent as `canvas.update` (base64); remote ones are applied.
 *   - After each (re)join + state fetch we push `encodeStateAsUpdate(doc, serverVector)`, i.e. exactly the
 *     edits the server doesn't have yet, so nothing typed offline or dropped by a rate limit is lost.
 *   - A debounced "verify" re-runs that state-vector handshake a few seconds after local edits settle.
 *   - Awareness (names, colors, carets) goes over `canvas.awareness`, throttled to ≤ 20 frames/s.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  MAX_AWARENESS_B64,
  MAX_UPDATE_B64,
  asCanvasEvent,
  canvasApi,
  fromBase64,
  toBase64,
  type CanvasClientFrame,
  type CanvasErrorCode,
} from "@/lib/canvas";
import { ApiError } from "@/lib/api";

import type { AwarenessUser, CanvasPeer, SyncStatus } from "./types";

/** Transaction origin for updates that came from the server (never echoed back). */
export const REMOTE_ORIGIN = Symbol("canvas-remote");

const FLUSH_MS = 80;
const AWARENESS_MIN_GAP_MS = 60;
const VERIFY_MS = 12_000;
const JOIN_TIMEOUT_MS = 8_000;
/** An encoded empty Yjs update (no structs, empty delete set). */
const EMPTY_UPDATE_LEN = 2;

export type ProviderSnapshot = {
  status: SyncStatus;
  /** Distinct other users (one entry per user, first tab wins). */
  peers: CanvasPeer[];
  /** Set when a change couldn't be synced (e.g. too large). */
  problem: string;
};

export type CanvasProviderOptions = {
  canvasId: string;
  user: AwarenessUser;
  send: (frame: CanvasClientFrame) => void;
  /** Called once when a change exceeds the frame limit and can't be synced. */
  onProblem?: (message: string) => void;
  /** The server refused us (403/404): access revoked or canvas deleted. */
  onDenied?: (message: string) => void;
};

function randomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class CanvasSyncProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** Per-tab id used to drop our own relayed frames. */
  readonly clientId = randomId();
  readonly canvasId: string;

  private opts: CanvasProviderOptions;
  private pending: Uint8Array[] = [];
  private flushTimer: number | undefined;
  private verifyTimer: number | undefined;
  private joinTimer: number | undefined;
  private joinAttempts = 0;
  private awarenessTimer: number | undefined;
  private awarenessDirty = new Set<number>();
  private lastAwarenessSent = 0;
  private connected = true;
  private joined = false;
  private destroyed = false;
  private started = false;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private lastSyncStart = 0;
  /** Server state vector from the last fetch; the diff against it is pushed once joined. */
  private diffBase: Uint8Array | null | undefined = undefined;
  private reportedProblem = false;
  private verifyOnVisible = false;
  /** Frame `client_id` (per remote tab) -> Yjs awareness client ids it announced (for `peer_left`). */
  private awarenessByFrameClient = new Map<string, Set<number>>();
  /** Frame client whose awareness update is being applied right now. */
  private applyingFrom: string | null = null;

  private listeners = new Set<() => void>();
  private snap: ProviderSnapshot = { status: "loading", peers: [], problem: "" };
  private peersKey = "";

  constructor(opts: CanvasProviderOptions) {
    this.opts = opts;
    this.canvasId = opts.canvasId;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField("user", opts.user);
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.awareness.on("change", this.onAwarenessChange);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
    }
  }

  // ---- external store ---------------------------------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snap;

  private setSnap(patch: Partial<ProviderSnapshot>) {
    const next = { ...this.snap, ...patch };
    if (next.status === this.snap.status && next.peers === this.snap.peers && next.problem === this.snap.problem) return;
    this.snap = next;
    this.listeners.forEach((fn) => fn());
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  /** Fetch + apply the stored state and join the live session. Rejects if the state can't be loaded. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sync();
  }

  setSend(send: CanvasProviderOptions["send"]) {
    this.opts = { ...this.opts, send };
  }

  /** Mirror the socket state: going offline drops the join; coming back re-joins and resyncs. */
  setConnected(open: boolean) {
    if (this.destroyed || open === this.connected) return;
    this.connected = open;
    if (!open) {
      this.joined = false;
      window.clearTimeout(this.joinTimer);
      // Remote carets would freeze in place; drop them until we're back.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      if (others.length) removeAwarenessStates(this.awareness, others, REMOTE_ORIGIN);
      if (this.snap.status !== "loading" && this.snap.status !== "denied") this.setSnap({ status: "offline" });
      return;
    }
    if (this.started) void this.sync().catch(() => {});
  }

  /** Feed every realtime event here. */
  handleEvent(raw: { type: string }) {
    if (this.destroyed) return;
    if (raw.type === "resync") {
      // The socket hook fires this after reconnecting; setConnected(true) usually beat us to it.
      if (this.started && Date.now() - this.lastSyncStart > 1500) void this.sync().catch(() => {});
      return;
    }
    const e = asCanvasEvent(raw);
    if (!e) return;
    if ("canvas_id" in e && e.canvas_id && e.canvas_id !== this.canvasId) return;
    switch (e.type) {
      case "canvas.joined":
        this.onJoined();
        break;
      case "canvas.update":
        if (e.client_id === this.clientId || !e.update) return;
        try {
          Y.applyUpdate(this.doc, fromBase64(e.update), REMOTE_ORIGIN);
        } catch {
          this.scheduleVerify(500);
          return;
        }
        // Missing dependencies (we lost a frame): fetch the full state soon.
        if (this.doc.store.pendingStructs || this.doc.store.pendingDs) this.scheduleVerify(1500);
        break;
      case "canvas.awareness":
        if (e.client_id === this.clientId || !e.update) return;
        this.applyingFrom = e.client_id;
        try {
          applyAwarenessUpdate(this.awareness, fromBase64(e.update), REMOTE_ORIGIN);
        } catch {
          // Malformed awareness frames are harmless; ignore.
        } finally {
          this.applyingFrom = null;
        }
        break;
      case "canvas.error":
        this.onServerError(e.error);
        break;
      case "canvas.deleted":
        this.deny("This canvas was deleted.");
        break;
      case "canvas.left":
      case "canvas.access_changed":
        // The server dropped our subscription: re-join (re-checking access) and resync.
        this.joined = false;
        if (this.started && this.connected) void this.sync().catch(() => {});
        break;
      case "canvas.peer_left": {
        const ids = new Set<number>();
        for (const cid of e.client_ids ?? []) {
          for (const id of this.awarenessByFrameClient.get(cid) ?? []) ids.add(id);
          this.awarenessByFrameClient.delete(cid);
        }
        const live = [...ids].filter((id) => id !== this.doc.clientID && this.awareness.getStates().has(id));
        if (live.length) removeAwarenessStates(this.awareness, live, REMOTE_ORIGIN);
        break;
      }
    }
  }

  /** Apply a locally generated update (e.g. a deterministic seed) and sync it like any edit. */
  applyLocal(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, "seed");
  }

  /** True when the server had nothing stored and the doc is still empty. */
  isEmpty(field = "default") {
    return this.doc.getXmlFragment(field).length === 0;
  }

  destroy() {
    if (this.destroyed) return;
    // Flush edits and tell peers our caret is gone while the socket can still carry it.
    this.flush(true);
    this.sendAwarenessRemoval();
    if (this.joined || this.started) this.opts.send({ type: "canvas.leave", canvas_id: this.canvasId });
    this.destroyed = true;
    window.clearTimeout(this.flushTimer);
    window.clearTimeout(this.verifyTimer);
    window.clearTimeout(this.joinTimer);
    window.clearTimeout(this.awarenessTimer);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.off("change", this.onAwarenessChange);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    this.listeners.clear();
    // The editor tears its Yjs binding down after us; give it a moment before destroying the doc.
    const { doc, awareness } = this;
    window.setTimeout(() => {
      awareness.destroy();
      doc.destroy();
    }, 1000);
  }

  // ---- sync handshake ---------------------------------------------------------------------------

  private sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    const run = async () => {
      do {
        this.syncAgain = false;
        this.lastSyncStart = Date.now();
        this.join();
        let state;
        try {
          state = await canvasApi.state(this.canvasId);
        } catch (err) {
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            this.deny(err.status === 404 ? "This canvas was deleted." : "You no longer have access to this canvas.");
          }
          throw err;
        }
        if (this.destroyed) return;
        if (state.state) Y.applyUpdate(this.doc, fromBase64(state.state), REMOTE_ORIGIN);
        this.diffBase = state.state_vector ? fromBase64(state.state_vector) : null;
        if (this.snap.status === "loading") this.setSnap({ status: this.joined ? "live" : this.connected ? "connecting" : "offline" });
        this.pushDiff();
      } while (this.syncAgain && !this.destroyed);
    };
    this.syncing = run().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private join() {
    if (this.destroyed || !this.connected) return;
    this.joined = false;
    if (this.snap.status === "live") this.setSnap({ status: "connecting" });
    this.opts.send({ type: "canvas.join", canvas_id: this.canvasId });
    this.joinAttempts++;
    window.clearTimeout(this.joinTimer);
    this.joinTimer = window.setTimeout(() => {
      if (this.joined || this.destroyed || !this.connected || this.snap.status === "denied") return;
      // Still no ack after a few tries: assume we're subscribed (an older server may not ack) rather
      // than holding edits back forever; the periodic state-vector verify keeps us honest.
      if (this.joinAttempts >= 3) this.onJoined();
      else this.join(); // frame dropped / server busy: ask again
    }, JOIN_TIMEOUT_MS);
  }

  private onJoined() {
    if (this.destroyed) return;
    this.joined = true;
    this.joinAttempts = 0;
    window.clearTimeout(this.joinTimer);
    if (this.snap.status !== "loading" && this.snap.status !== "denied") this.setSnap({ status: "live" });
    // Announce ourselves so peers draw our caret immediately.
    this.awarenessDirty.add(this.doc.clientID);
    this.flushAwareness();
    this.pushDiff();
    this.flush();
  }

  /** Send whatever the server is missing relative to the last state vector it gave us. */
  private pushDiff() {
    if (this.diffBase === undefined || !this.joined || !this.connected || this.destroyed) return;
    const update = Y.encodeStateAsUpdate(this.doc, this.diffBase ?? undefined);
    this.diffBase = undefined;
    // Everything queued so far is part of this diff.
    this.pending = [];
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (update.length > EMPTY_UPDATE_LEN) this.sendUpdate(update);
  }

  /** React to a refused frame (`canvas.error`). */
  private onServerError(code: CanvasErrorCode) {
    switch (code) {
      case "not_found":
        this.deny("This canvas was deleted, or you no longer have access to it.");
        break;
      case "too_large":
        this.reportProblem("This canvas has reached its size limit, so recent changes couldn't be saved.");
        break;
      case "read_only":
        this.reportProblem("This canvas is read-only, so your changes weren't saved.");
        break;
      case "too_many_canvases":
        this.reportProblem("Too many canvases are open in this window. Close a few and reload to sync live.");
        break;
      case "rate_limited":
      case "invalid_update":
        // A dropped update: the state-vector handshake re-sends whatever the server is missing.
        this.scheduleVerify(this.joined ? 2000 : 4000);
        break;
    }
  }

  private deny(message: string) {
    if (this.snap.status === "denied") return;
    window.clearTimeout(this.joinTimer);
    this.setSnap({ status: "denied", problem: message });
    this.opts.onDenied?.(message);
  }

  // ---- document updates -------------------------------------------------------------------------

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN || this.destroyed) return;
    this.pending.push(update);
    if (this.flushTimer === undefined) this.flushTimer = window.setTimeout(() => this.flush(), FLUSH_MS);
    this.scheduleVerify();
  };

  private flush(final = false) {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.pending.length) return;
    // Not live yet: keep the queue; the state-vector diff after (re)joining covers it anyway.
    if (!this.connected || (!this.joined && !final)) return;
    const updates = this.pending;
    this.pending = [];
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    if (!this.sendUpdate(merged, true) && updates.length > 1) {
      for (const u of updates) this.sendUpdate(u);
    }
  }

  /** Returns false (without reporting) when `quiet` and the update is over the frame limit. */
  private sendUpdate(update: Uint8Array, quiet = false): boolean {
    const b64 = toBase64(update);
    if (b64.length > MAX_UPDATE_B64) {
      if (!quiet) this.reportProblem("That change is too large to sync live. Try splitting it into smaller pastes.");
      return false;
    }
    this.opts.send({ type: "canvas.update", canvas_id: this.canvasId, client_id: this.clientId, update: b64 });
    return true;
  }

  private reportProblem(message: string) {
    this.setSnap({ problem: message });
    if (this.reportedProblem) return;
    this.reportedProblem = true;
    this.opts.onProblem?.(message);
  }

  private scheduleVerify(ms = VERIFY_MS) {
    if (this.destroyed) return;
    window.clearTimeout(this.verifyTimer);
    this.verifyTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      if (document.visibilityState !== "visible") {
        this.verifyOnVisible = true;
        return;
      }
      void this.sync().catch(() => {});
    }, ms);
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible" || this.destroyed) return;
    if (this.verifyOnVisible) {
      this.verifyOnVisible = false;
      void this.sync().catch(() => {});
    }
  };

  private onPageHide = () => {
    this.flush(true);
    this.sendAwarenessRemoval();
  };

  /** Restored from the back/forward cache: come back to life. */
  private onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted || this.destroyed) return;
    if (this.awareness.getLocalState() === null) this.awareness.setLocalStateField("user", this.opts.user);
    void this.sync().catch(() => {});
  };

  // ---- awareness --------------------------------------------------------------------------------

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (this.destroyed) return;
    if (origin === REMOTE_ORIGIN) {
      if (this.applyingFrom) {
        let known = this.awarenessByFrameClient.get(this.applyingFrom);
        if (!known) this.awarenessByFrameClient.set(this.applyingFrom, (known = new Set()));
        for (const id of [...added, ...updated]) known.add(id);
        for (const id of removed) known.delete(id);
      }
      // Someone new arrived: make sure they learn about us without waiting for the 15 s renewal.
      if (added.some((id) => id !== this.doc.clientID)) {
        this.awarenessDirty.add(this.doc.clientID);
        this.scheduleAwareness();
      }
      return;
    }
    for (const id of [...added, ...updated, ...removed]) if (id === this.doc.clientID) this.awarenessDirty.add(id);
    if (this.awarenessDirty.size) this.scheduleAwareness();
  };

  private scheduleAwareness() {
    if (this.awarenessTimer !== undefined) return;
    const wait = Math.max(0, AWARENESS_MIN_GAP_MS - (Date.now() - this.lastAwarenessSent));
    this.awarenessTimer = window.setTimeout(() => {
      this.awarenessTimer = undefined;
      this.flushAwareness();
    }, wait);
  }

  private flushAwareness() {
    if (!this.awarenessDirty.size || !this.joined || !this.connected || this.destroyed) return;
    const clients = [...this.awarenessDirty];
    this.awarenessDirty.clear();
    const b64 = toBase64(encodeAwarenessUpdate(this.awareness, clients));
    if (b64.length > MAX_AWARENESS_B64) return;
    this.lastAwarenessSent = Date.now();
    this.opts.send({ type: "canvas.awareness", canvas_id: this.canvasId, client_id: this.clientId, update: b64 });
  }

  /** Tell peers our caret is gone (synchronously, while the socket can still carry it). */
  private sendAwarenessRemoval() {
    if (this.destroyed || !this.joined || !this.connected || this.awareness.getLocalState() === null) return;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    window.clearTimeout(this.awarenessTimer);
    this.awarenessTimer = undefined;
    this.flushAwareness();
  }

  private onAwarenessChange = () => {
    const seen = new Set<string>();
    const peers: CanvasPeer[] = [];
    const states = [...this.awareness.getStates().entries()].sort((a, b) => a[0] - b[0]);
    for (const [clientId, state] of states) {
      if (clientId === this.doc.clientID) continue;
      const u = (state as { user?: Partial<AwarenessUser> } | undefined)?.user;
      if (!u?.id || u.id === this.opts.user.id || seen.has(u.id)) continue;
      seen.add(u.id);
      peers.push({ clientId, userId: u.id, name: u.name || "Someone", color: u.color || "#64748b" });
    }
    const key = peers.map((p) => `${p.clientId}:${p.userId}:${p.name}:${p.color}`).join("|");
    if (key === this.peersKey) return;
    this.peersKey = key;
    this.setSnap({ peers });
  };
}
