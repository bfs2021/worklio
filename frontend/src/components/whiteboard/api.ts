import { API_URL, ApiError, api, freshToken } from "@/lib/api";

import type { Whiteboard, WhiteboardElement, WhiteboardSaveResult } from "./types";
import { sanitizeElements } from "./utils";

function normalize(raw: unknown, channelId: string): Whiteboard {
  const w = (raw ?? {}) as Partial<Whiteboard>;
  return {
    channel_id: w.channel_id ?? channelId,
    elements: sanitizeElements(w.elements),
    version: typeof w.version === "number" ? w.version : 0,
    updated_by: w.updated_by ?? null,
    updated_at: w.updated_at ?? new Date(0).toISOString(),
  };
}

export async function fetchWhiteboard(channelId: string): Promise<Whiteboard> {
  return normalize(await api<Whiteboard>(`/channels/${channelId}/whiteboard`), channelId);
}

/**
 * PUT the scene. A 409 resolves with the server's current copy (to reconcile against) instead of
 * throwing. Network failures reject with a TypeError (see `isNetworkError`).
 */
export async function saveWhiteboard(
  channelId: string,
  body: { elements: WhiteboardElement[]; base_version: number },
  opts: { keepalive?: boolean } = {},
): Promise<WhiteboardSaveResult> {
  const token = await freshToken();
  const payload = JSON.stringify(body);
  const res = await fetch(`${API_URL}/channels/${channelId}/whiteboard`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: payload,
    // Browsers cap keepalive bodies at 64 KB.
    keepalive: opts.keepalive && payload.length < 60_000,
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => null);
    const current = data?.whiteboard ?? data?.detail?.whiteboard;
    if (current) return { kind: "conflict", whiteboard: normalize(current, channelId) };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    let detail = typeof data?.detail === "string" ? data.detail : res.statusText;
    if (res.status === 413) detail = "This whiteboard is too large to save (5 MB limit).";
    throw new ApiError(res.status, detail || "Couldn't save the whiteboard");
  }
  return { kind: "saved", whiteboard: normalize(await res.json(), channelId) };
}

export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);
}
