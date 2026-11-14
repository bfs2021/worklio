import { api, API_URL, ApiError, freshToken } from "@/lib/api";

import type { CallNotes, CallNotesSaveResult } from "./types";

export function fetchCallNotes(callId: string): Promise<CallNotes> {
  return api<CallNotes>(`/calls/${callId}/notes`);
}

/**
 * PUT the call notes. A 409 resolves with the server's current copy instead of throwing, so the
 * caller can reconcile. Network failures reject with a TypeError.
 */
export async function saveCallNotes(
  callId: string,
  body: { content: unknown; base_version: number },
  opts: { keepalive?: boolean } = {},
): Promise<CallNotesSaveResult> {
  const token = await freshToken();
  const payload = JSON.stringify(body);
  const res = await fetch(`${API_URL}/calls/${callId}/notes`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: payload,
    keepalive: opts.keepalive && payload.length < 60_000,
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => null);
    const notes: CallNotes | undefined = data?.notes ?? data?.detail?.notes;
    if (notes) return { kind: "conflict", notes };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    let detail = typeof data?.detail === "string" ? data.detail : res.statusText;
    if (res.status === 413) detail = "These notes are too large to save.";
    throw new ApiError(res.status, detail || "Couldn't save the notes");
  }
  return { kind: "saved", notes: (await res.json()) as CallNotes };
}

export function cancelRinging(callId: string) {
  return api<void>(`/calls/${callId}/cancel`, { method: "POST" });
}

export function inviteToCallApi(callId: string, userIds: string[]) {
  return api<unknown>(`/calls/${callId}/invite`, { method: "POST", body: JSON.stringify({ user_ids: userIds }) });
}
