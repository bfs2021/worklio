/**
 * Realtime + persistence engine for one channel's whiteboard. Framework-free on purpose:
 * all mutable bookkeeping (sent versions, timers, base version) lives here, React only reads
 * the small stores exposed below via useSyncExternalStore.
 *
 * Imports Excalidraw at runtime, so only load this from the client-only (ssr:false) module.
 */
import { CaptureUpdateAction, newElementWith, reconcileElements } from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types";

import { ApiError } from "@/lib/api";

import { fetchWhiteboard, isNetworkError, saveWhiteboard } from "./api";
import type {
  SaveStatus,
  Whiteboard,
  WhiteboardElement,
  WhiteboardPeer,
  WhiteboardPointerFrame,
  WhiteboardRealtimeEvent,
} from "./types";
import { MAX_ELEMENTS, collaboratorColor, isElement } from "./utils";

const OPS_THROTTLE_MS = 60;
const POINTER_THROTTLE_MS = 60; // server allows ≤ 20/s
const SAVE_DEBOUNCE_MS = 2_000;
const OFFLINE_RETRY_MS = 5_000;
const ERROR_RETRY_MS = 15_000;
const RESYNC_MS = 30_000;
const CURSOR_STALE_MS = 5_000;
/** Presence heartbeat while the tab is visible, so people who are only looking show up too. */
const PRESENCE_MS = 10_000;
/** Three missed heartbeats and you're gone from everyone's header. */
const PEER_STALE_MS = 32_000;
/**
 * Pointer coordinates that mean "I'm here" without a cursor. The relay only forwards x/y/tool,
 * so presence rides on a pointer frame at a sentinel spot far outside any real drawing (clients
 * that don't know it would draw a cursor ten million pixels away, i.e. nowhere visible).
 */
const PRESENCE_COORD = -9_999_999;
const MAX_OPS_PER_FRAME = 300;
const MAX_FRAME_CHARS = 200_000; // frame limit is 256 KB; leave room for the envelope + UTF-8
const MAX_FRAMES_PER_TICK = 4;

type Listener = () => void;

export type MemberInfo = { name: string; avatarUrl?: string | null };

export type SyncOptions = {
  channelId: string;
  clientId: string;
  meId: string | undefined;
  initial: Whiteboard;
  readOnly: boolean;
  send: (frame: object) => void;
  member: (userId: string) => MemberInfo;
  onError?: (message: string) => void;
};

type Cursor = { userId: string; x: number; y: number; tool: "pointer" | "laser"; seen: number };

function versionHash(elements: readonly { id: string; version: number }[]): number {
  let h = elements.length;
  for (const el of elements) h = (h * 31 + el.version) | 0;
  return h;
}

export class WhiteboardSync {
  private opts: SyncOptions;
  private api: ExcalidrawImperativeAPI | null = null;
  /** Element id → version the network already has (sent by us, received, or loaded). */
  private known = new Map<string, number>();
  private baseVersion: number;
  private lastHash = 0;
  /** Bumped on each local edit; a save only marks the board clean if no edit happened meanwhile. */
  private changeSeq = 0;
  private savedSeq = 0;
  private saving = false;
  /** True while not mounted (before attach / after detach). Survives StrictMode re-mounts. */
  private disposed = true;

  private opsTimer: number | null = null;
  private lastOpsAt = 0;
  private saveTimer: number | null = null;
  private pointerTimer: number | null = null;
  private lastPointerAt = 0;
  private pendingPointer: { x: number; y: number; tool: "pointer" | "laser" } | null = null;
  private presenceTimer: number | null = null;
  private intervals: number[] = [];

  private cursors = new Map<string, Cursor>();
  private peerSeen = new Map<string, number>();

  // --- stores ---
  private listeners = new Set<Listener>();
  private status: SaveStatus;
  private peers: WhiteboardPeer[] = [];
  private empty: boolean;

  constructor(opts: SyncOptions) {
    this.opts = opts;
    this.baseVersion = opts.initial.version;
    for (const el of opts.initial.elements) this.known.set(el.id, el.version);
    this.lastHash = versionHash(opts.initial.elements);
    this.status = opts.readOnly ? "readonly" : "saved";
    this.empty = !opts.initial.elements.some((el) => !el.isDeleted);
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getStatus = () => this.status;
  getPeers = () => this.peers;
  getEmpty = () => this.empty;

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
  private setStatus(s: SaveStatus) {
    if (this.opts.readOnly) s = "readonly";
    if (s === this.status) return;
    this.status = s;
    this.emit();
  }
  private setEmpty(e: boolean) {
    if (e === this.empty) return;
    this.empty = e;
    this.emit();
  }

  /** Called on every render with fresh callbacks (sendRealtime/member lookups may change). */
  update(partial: Pick<SyncOptions, "send" | "member" | "meId" | "readOnly" | "onError">) {
    const wasReadOnly = this.opts.readOnly;
    this.opts = { ...this.opts, ...partial };
    if (wasReadOnly !== partial.readOnly) this.setStatus(partial.readOnly ? "readonly" : "saved");
  }

  setApi = (api: ExcalidrawImperativeAPI | null) => {
    this.api = api;
    if (!api || this.disposed) return;
    this.start();
  };

  getApi = () => this.api;

  /** Start timers/listeners; returns the cleanup (use as an effect). */
  attach = () => {
    this.disposed = false;
    if (this.api) this.start();
    if (this.isDirty()) this.scheduleSave(SAVE_DEBOUNCE_MS);
    return () => this.detach();
  };

  private start() {
    if (this.intervals.length) return;
    this.intervals.push(window.setInterval(() => this.pruneCursors(), 1_000));
    this.intervals.push(
      window.setInterval(() => {
        if (document.visibilityState === "visible") void this.resync();
      }, RESYNC_MS),
    );
    this.intervals.push(window.setInterval(() => this.sendPresence(), PRESENCE_MS));
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.sendPresence();
  }

  private detach() {
    if (this.disposed) return;
    this.flushOps();
    if (this.isDirty() && !this.opts.readOnly) void this.save({ keepalive: true });
    this.disposed = true;
    this.intervals.forEach((id) => window.clearInterval(id));
    this.intervals = [];
    for (const t of [this.opsTimer, this.saveTimer, this.pointerTimer, this.presenceTimer]) {
      if (t != null) window.clearTimeout(t);
    }
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.opsTimer = this.saveTimer = this.pointerTimer = this.presenceTimer = null;
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.sendPresence();
  };

  /** Lightweight "I'm looking at this board" ping (only while the tab is visible). */
  private sendPresence(force = false) {
    if (this.disposed || document.visibilityState !== "visible") return;
    // Someone who just moved their pointer is already announcing themselves.
    if (!force && Date.now() - this.lastPointerAt < PRESENCE_MS / 2) return;
    const frame: WhiteboardPointerFrame = {
      type: "whiteboard.pointer",
      channel_id: this.opts.channelId,
      client_id: this.opts.clientId,
      x: PRESENCE_COORD,
      y: PRESENCE_COORD,
      tool: "pointer",
    };
    this.opts.send(frame);
  }

  /** Answer a newcomer soon (with jitter, so a crowd doesn't reply in one burst). */
  private schedulePresenceReply() {
    if (this.presenceTimer != null || this.disposed) return;
    this.presenceTimer = window.setTimeout(
      () => {
        this.presenceTimer = null;
        this.sendPresence(true);
      },
      250 + Math.random() * 750,
    );
  }

  private onPageHide = () => {
    this.flushOps();
    if (this.isDirty() && !this.opts.readOnly) void this.save({ keepalive: true });
  };
  private onOnline = () => {
    if (this.isDirty()) this.scheduleSave(0);
    void this.resync();
  };

  private isDirty() {
    return this.changeSeq !== this.savedSeq;
  }

  private scene(): readonly OrderedExcalidrawElement[] {
    return (this.api?.getSceneElementsIncludingDeleted() ?? []) as readonly OrderedExcalidrawElement[];
  }

  // ---------------------------------------------------------------------------------------------
  // Local edits

  /** Excalidraw onChange (fires for every appState change too, so bail out cheaply). */
  onChange = (elements: readonly ExcalidrawElement[]) => {
    const hash = versionHash(elements);
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    this.setEmpty(!elements.some((el) => !el.isDeleted));
    if (this.opts.readOnly) return;
    let changed = false;
    for (const el of elements) {
      if (this.known.get(el.id) !== el.version) {
        changed = true;
        break;
      }
    }
    if (!changed) return; // a remote update we just applied
    this.changeSeq++;
    this.scheduleOps();
    this.scheduleSave(SAVE_DEBOUNCE_MS);
    if (this.status !== "offline") this.setStatus("saving");
  };

  private scheduleOps() {
    if (this.opsTimer != null) return;
    const wait = Math.max(0, OPS_THROTTLE_MS - (Date.now() - this.lastOpsAt));
    this.opsTimer = window.setTimeout(() => {
      this.opsTimer = null;
      this.flushOps();
    }, wait);
  }

  /** Broadcast elements whose version the network hasn't seen, in size-bounded frames. */
  private flushOps() {
    if (!this.api || this.opts.readOnly) return;
    this.lastOpsAt = Date.now();
    const pending = this.scene().filter((el) => this.known.get(el.id) !== el.version);
    let i = 0;
    let frames = 0;
    while (i < pending.length && frames < MAX_FRAMES_PER_TICK) {
      const batch: ExcalidrawElement[] = [];
      let size = 0;
      while (i < pending.length && batch.length < MAX_OPS_PER_FRAME) {
        const el = pending[i];
        const len = JSON.stringify(el).length;
        if (len > MAX_FRAME_CHARS) {
          // Too big for a live frame; it still reaches everyone through the saved scene.
          this.known.set(el.id, el.version);
          i++;
          continue;
        }
        if (size + len > MAX_FRAME_CHARS && batch.length) break;
        batch.push(el);
        size += len;
        i++;
      }
      if (!batch.length) continue;
      for (const el of batch) this.known.set(el.id, el.version);
      this.opts.send({
        type: "whiteboard.ops",
        channel_id: this.opts.channelId,
        client_id: this.opts.clientId,
        elements: batch,
      });
      frames++;
    }
    if (i < pending.length) this.scheduleOps();
  }

  /** Excalidraw onPointerUpdate (scene coordinates). */
  onPointerUpdate = ({ pointer }: { pointer: { x: number; y: number; tool: "pointer" | "laser" } }) => {
    if (this.disposed || this.opts.readOnly) return;
    if (pointer.x === PRESENCE_COORD && pointer.y === PRESENCE_COORD) return;
    this.pendingPointer = { x: Math.round(pointer.x * 10) / 10, y: Math.round(pointer.y * 10) / 10, tool: pointer.tool };
    if (this.pointerTimer != null) return;
    const wait = Math.max(0, POINTER_THROTTLE_MS - (Date.now() - this.lastPointerAt));
    this.pointerTimer = window.setTimeout(() => {
      this.pointerTimer = null;
      const p = this.pendingPointer;
      this.pendingPointer = null;
      if (!p || document.visibilityState !== "visible") return;
      this.lastPointerAt = Date.now();
      const frame: WhiteboardPointerFrame = {
        type: "whiteboard.pointer",
        channel_id: this.opts.channelId,
        client_id: this.opts.clientId,
        ...p,
      };
      this.opts.send(frame);
    }, wait);
  };

  /** Delete every element (as an undoable local edit that syncs like any other). */
  clear() {
    if (!this.api || this.opts.readOnly) return;
    const next = this.scene().map((el) => (el.isDeleted ? el : newElementWith(el, { isDeleted: true })));
    this.api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  // ---------------------------------------------------------------------------------------------
  // Remote edits + presence

  handleEvent(raw: { type: string }) {
    if (this.disposed) return;
    if (raw.type === "resync") {
      void this.resync();
      return;
    }
    if (raw.type !== "whiteboard.ops" && raw.type !== "whiteboard.pointer") return;
    const e = raw as WhiteboardRealtimeEvent;
    if (e.channel_id !== this.opts.channelId || e.client_id === this.opts.clientId) return;
    this.touchPeer(e.user_id);
    if (e.type === "whiteboard.pointer") {
      if (typeof e.x !== "number" || typeof e.y !== "number") return;
      if (e.x === PRESENCE_COORD && e.y === PRESENCE_COORD) return; // presence only, no cursor
      this.cursors.set(`${e.user_id}:${e.client_id}`, {
        userId: e.user_id,
        x: e.x,
        y: e.y,
        tool: e.tool === "laser" ? "laser" : "pointer",
        seen: Date.now(),
      });
      this.pushCollaborators();
      return;
    }
    const incoming = Array.isArray(e.elements) ? e.elements.filter(isElement) : [];
    if (incoming.length) this.applyRemote(incoming);
  }

  /** Merge remote elements into the scene without echoing them back or polluting undo. */
  private applyRemote(remote: WhiteboardElement[]) {
    const api = this.api;
    if (!api) return;
    for (const el of remote) {
      const k = this.known.get(el.id);
      if (k == null || el.version > k) this.known.set(el.id, el.version);
    }
    const merged = reconcileElements(
      this.scene(),
      remote as unknown as RemoteExcalidrawElement[],
      api.getAppState(),
    );
    api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private touchPeer(userId: string) {
    if (!userId || userId === this.opts.meId) return;
    const had = this.peerSeen.has(userId);
    this.peerSeen.set(userId, Date.now());
    if (!had) {
      this.rebuildPeers();
      this.schedulePresenceReply();
    }
  }

  private rebuildPeers() {
    this.peers = [...this.peerSeen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([userId, lastSeen]) => ({ userId, lastSeen }));
    this.emit();
  }

  private pruneCursors() {
    const now = Date.now();
    let cursorsChanged = false;
    for (const [k, c] of this.cursors) {
      if (now - c.seen > CURSOR_STALE_MS) {
        this.cursors.delete(k);
        cursorsChanged = true;
      }
    }
    if (cursorsChanged) this.pushCollaborators();
    let peersChanged = false;
    for (const [id, t] of this.peerSeen) {
      if (now - t > PEER_STALE_MS) {
        this.peerSeen.delete(id);
        peersChanged = true;
      }
    }
    if (peersChanged) this.rebuildPeers();
  }

  private pushCollaborators() {
    if (!this.api) return;
    const map = new Map<SocketId, Collaborator>();
    for (const [key, c] of this.cursors) {
      const info = this.opts.member(c.userId);
      map.set(key as SocketId, {
        id: c.userId,
        socketId: key as SocketId,
        username: info.name,
        avatarUrl: info.avatarUrl ?? undefined,
        color: collaboratorColor(c.userId),
        pointer: { x: c.x, y: c.y, tool: c.tool },
        button: "up",
      });
    }
    this.api.updateScene({ collaborators: map });
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence

  private scheduleSave(delay: number) {
    if (this.opts.readOnly || this.disposed) return;
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delay);
  }

  private async save(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.opts.readOnly || !this.api) return;
    if (this.saving && !opts.keepalive) {
      this.scheduleSave(SAVE_DEBOUNCE_MS);
      return;
    }
    const seq = this.changeSeq;
    const elements = this.scene() as unknown as WhiteboardElement[];
    if (elements.length > MAX_ELEMENTS) {
      this.setStatus("error");
      this.opts.onError?.(`This whiteboard has too many shapes to save (max ${MAX_ELEMENTS.toLocaleString()}).`);
      return;
    }
    this.saving = true;
    let retry = false;
    if (!this.disposed) this.setStatus("saving");
    try {
      const res = await saveWhiteboard(
        this.opts.channelId,
        { elements, base_version: this.baseVersion },
        opts,
      );
      if (this.disposed) return;
      if (res.kind === "conflict") {
        // Someone saved in between: fold their scene into ours and try again on top of it.
        this.absorbServer(res.whiteboard);
        retry = true;
        return;
      }
      this.baseVersion = Math.max(this.baseVersion, res.whiteboard.version);
      if (this.changeSeq === seq) {
        this.savedSeq = seq;
        this.setStatus("saved");
      } else {
        this.setStatus("saving");
        this.scheduleSave(SAVE_DEBOUNCE_MS);
      }
    } catch (err) {
      if (this.disposed) return;
      if (isNetworkError(err)) {
        this.setStatus("offline");
        this.scheduleSave(OFFLINE_RETRY_MS);
      } else {
        this.setStatus("error");
        const status = err instanceof ApiError ? err.status : 0;
        if (status === 413 || status === 422 || status === 403) {
          this.opts.onError?.(err instanceof Error ? err.message : "Couldn't save the whiteboard");
        } else {
          this.scheduleSave(ERROR_RETRY_MS);
        }
      }
    } finally {
      this.saving = false;
      if (retry && !this.disposed) void this.save();
    }
  }

  /** Merge a server snapshot into the scene and adopt its version as our base. */
  private absorbServer(server: Whiteboard) {
    this.baseVersion = Math.max(this.baseVersion, server.version);
    if (server.elements.length) this.applyRemote(server.elements);
  }

  /** Pull the persisted scene (after reconnects and periodically) so missed frames converge. */
  private async resync() {
    if (this.disposed || this.saving) return;
    try {
      const server = await fetchWhiteboard(this.opts.channelId);
      if (this.disposed || server.version === this.baseVersion) return;
      this.absorbServer(server);
      if (this.status === "offline") this.setStatus(this.isDirty() ? "saving" : "saved");
    } catch {
      /* transient; the next tick retries */
    }
  }
}
