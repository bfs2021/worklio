import type { JSONContent } from "@tiptap/react";

export type { Canvas, CanvasAccess, CanvasComment, CanvasDetail } from "@/lib/canvas";

export type CanvasTemplate = {
  id: string;
  name: string;
  description: string;
  /** Emoji shown on the template card (and suggested for the canvas). */
  emoji: string;
  title: string;
  content: JSONContent;
};

/** One collaborator currently in the canvas (from Yjs awareness). */
export type CanvasPeer = {
  /** Yjs awareness client id (one per tab). */
  clientId: number;
  userId: string;
  name: string;
  color: string;
};

/** The awareness `user` field every tab publishes (also used by CollaborationCaret). */
export type AwarenessUser = { id: string; name: string; color: string };

export type SyncStatus =
  /** Loading the initial state. */
  | "loading"
  /** Waiting for the server to confirm the join (or re-joining after a reconnect). */
  | "connecting"
  | "live"
  /** The realtime socket is down; edits are kept locally and pushed on reconnect. */
  | "offline"
  /** The server refused the canvas (access revoked / deleted). */
  | "denied";
