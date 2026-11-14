/**
 * Canvases v2: multi-canvas documents (standalone or one per channel) synced with Yjs over the
 * shared realtime WebSocket. Types mirror the backend contract; the helpers wrap the REST API.
 */
import type { JSONContent } from "@tiptap/react";

import { api, type Attachment } from "@/lib/api";

export type CanvasAccess = "workspace" | "private" | "channel";

export type Canvas = {
  id: string;
  workspace_id: string;
  /** null for standalone canvases. */
  channel_id: string | null;
  title: string;
  emoji: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  access: CanvasAccess;
  /** Explicit members (private canvases only). */
  member_ids: string[];
  is_channel_canvas: boolean;
};

/** GET /canvases/{id}: the canvas plus the pre-Yjs JSON doc, used once to seed an empty Yjs state. */
export type CanvasDetail = Canvas & { legacy_content: JSONContent | null };

export type CanvasState = {
  /** base64 Yjs update encoding the full document ("" when nothing was written yet). */
  state: string;
  /** base64 Yjs state vector of that document. */
  state_vector: string;
};

export type CanvasComment = {
  id: string;
  canvas_id: string;
  /** Root comment id (equal to `id` for a root). */
  thread_id: string;
  /** Client-generated id of the `comment` mark in the document, if anchored. */
  anchor_id: string | null;
  body: string;
  author_id: string;
  created_at: string;
  resolved: boolean;
  quote: string | null;
};

export type CreateCanvasBody = {
  title: string;
  emoji?: string | null;
  access: Exclude<CanvasAccess, "channel">;
  member_ids?: string[];
  channel_id?: string | null;
};

export type UpdateCanvasBody = Partial<Pick<Canvas, "title" | "emoji" | "access" | "member_ids">>;

// ---- realtime frames ----------------------------------------------------------------------------

/** Why the server refused a canvas frame (`canvas.error`). */
export type CanvasErrorCode =
  | "not_found"
  | "invalid_update"
  | "too_large"
  | "rate_limited"
  | "read_only"
  | "too_many_canvases";

export type CanvasServerEvent =
  | { type: "canvas.joined"; canvas_id: string }
  | { type: "canvas.update"; canvas_id: string; client_id: string; update: string }
  | { type: "canvas.awareness"; canvas_id: string; client_id: string; update: string }
  | { type: "canvas.comments.updated"; canvas_id: string }
  /** Metadata changed (title, emoji, sharing). The legacy channel PUT sends `channel_id` instead. */
  | { type: "canvas.updated"; canvas_id?: string; channel_id?: string; canvas?: Partial<Canvas> & { id?: string } }
  | { type: "canvas.deleted"; canvas_id: string }
  /** Sharing changed: the server dropped every subscriber; re-join to re-check access. */
  | { type: "canvas.access_changed"; canvas_id: string }
  /** This socket was unsubscribed (left the channel / lost access); re-join to re-check. */
  | { type: "canvas.left"; canvas_id: string; reason: string }
  /** A peer's socket left: drop the carets of these (frame) client ids at once. */
  | { type: "canvas.peer_left"; canvas_id: string; user_id: string; client_ids: string[] }
  | { type: "canvas.error"; canvas_id: string; error: CanvasErrorCode }
  /** Workspace topic: the canvas list changed (refetch; carries no titles). */
  | { type: "canvases.changed"; workspace_id: string };

export type CanvasClientFrame =
  | { type: "canvas.join"; canvas_id: string }
  | { type: "canvas.leave"; canvas_id: string }
  | { type: "canvas.update"; canvas_id: string; client_id: string; update: string }
  | { type: "canvas.awareness"; canvas_id: string; client_id: string; update: string };

/** Narrow an arbitrary realtime event to a canvas event. */
export function asCanvasEvent(e: { type: string }): CanvasServerEvent | null {
  return e.type.startsWith("canvas.") || e.type === "canvases.changed" ? (e as unknown as CanvasServerEvent) : null;
}

/** Limits from the contract (base64 lengths, so the server never has to drop a frame). */
export const MAX_UPDATE_B64 = 512 * 1024;
export const MAX_AWARENESS_B64 = 32 * 1024;

// ---- REST ---------------------------------------------------------------------------------------

export const canvasApi = {
  list: (workspaceId: string, q = "") =>
    api<Canvas[]>(`/workspaces/${workspaceId}/canvases${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`),
  create: (workspaceId: string, body: CreateCanvasBody) =>
    api<Canvas>(`/workspaces/${workspaceId}/canvases`, { method: "POST", body: JSON.stringify(body) }),
  get: (canvasId: string) => api<CanvasDetail>(`/canvases/${canvasId}`),
  update: (canvasId: string, body: UpdateCanvasBody) =>
    api<Canvas>(`/canvases/${canvasId}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (canvasId: string) => api<void>(`/canvases/${canvasId}`, { method: "DELETE" }),
  forChannel: (channelId: string) => api<Canvas>(`/channels/${channelId}/canvas`),
  state: (canvasId: string) => api<CanvasState>(`/canvases/${canvasId}/state`),
  comments: (canvasId: string) => api<CanvasComment[]>(`/canvases/${canvasId}/comments`),
  addComment: (
    canvasId: string,
    body: { body: string; anchor_id?: string | null; quote?: string | null; thread_id?: string | null },
  ) => api<CanvasComment>(`/canvases/${canvasId}/comments`, { method: "POST", body: JSON.stringify(body) }),
  updateComment: (commentId: string, body: { body?: string; resolved?: boolean }) =>
    api<CanvasComment>(`/canvas-comments/${commentId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteComment: (commentId: string) => api<void>(`/canvas-comments/${commentId}`, { method: "DELETE" }),
};

// ---- helpers ------------------------------------------------------------------------------------

/** Uint8Array -> base64, chunked so large updates don't blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Caret colors must be `#rrggbb` (CollaborationCaret rejects anything else). */
const CARET_COLORS = [
  "#e11d48",
  "#d97706",
  "#059669",
  "#0284c7",
  "#7c3aed",
  "#db2777",
  "#0d9488",
  "#ea580c",
  "#4f46e5",
  "#65a30d",
];

export function caretColorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return CARET_COLORS[Math.abs(h) % CARET_COLORS.length];
}

export function canvasHref(workspaceId: string, canvasId: string) {
  return `/w/${workspaceId}/canvas/${canvasId}`;
}

/** Can `userId` delete this canvas? (Creator or workspace admin; channel canvases never.) */
export function canDeleteCanvas(c: Canvas, userId: string | undefined, isAdmin: boolean) {
  return !c.is_channel_canvas && (isAdmin || (!!userId && c.created_by === userId));
}

// ---- expiring image links -----------------------------------------------------------------------

/** Upload links are presigned for an hour; re-sign a little before that. */
const SIGNED_URL_TTL_MS = 50 * 60 * 1000;
const signedUrls = new Map<string, { url: string; expires: number } | Promise<string | null>>();

/** A fresh download URL for an attachment (cached; null if it's gone or no longer readable). */
export function freshAttachmentUrl(attachmentId: string): Promise<string | null> {
  const hit = signedUrls.get(attachmentId);
  if (hit instanceof Promise) return hit;
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.url);
  const pending = api<Attachment>(`/attachments/${encodeURIComponent(attachmentId)}/url`).then(
    (a) => {
      signedUrls.set(attachmentId, { url: a.url, expires: Date.now() + SIGNED_URL_TTL_MS });
      return a.url;
    },
    () => {
      signedUrls.delete(attachmentId);
      return null;
    },
  );
  signedUrls.set(attachmentId, pending);
  return pending;
}

function onImageError(ev: Event) {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement)) return;
  const id = img.dataset.attachmentId;
  // One retry per element: a second failure means the file itself is gone.
  if (!id || img.dataset.resigned === "1") return;
  img.dataset.resigned = "1";
  void freshAttachmentUrl(id).then((url) => {
    if (url && img.isConnected && img.src !== url) img.src = url;
  });
}

/**
 * Callback ref for a container of rendered canvas HTML: when an `<img data-attachment-id>` fails
 * to load (its stored link expired), swap in a freshly signed URL. Only the DOM is touched — the
 * document keeps the attachment id, which is what matters.
 */
export function resignExpiredImages(el: HTMLElement | null) {
  if (!el) return;
  el.addEventListener("error", onImageError, true);
  return () => el.removeEventListener("error", onImageError, true);
}
