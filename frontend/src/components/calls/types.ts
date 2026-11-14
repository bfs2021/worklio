import type { Message } from "@/lib/api";

/** Mirrors the Stage 1 call API contract (backend/app/api/routes/calls.py). */

export type CallKind = "audio" | "video";
export type CallStatus = "ringing" | "active" | "ended" | "missed" | "declined" | "cancelled";
export type CallInviteStatus = "ringing" | "accepted" | "declined" | "missed" | "cancelled";

export type CallInvite = { user_id: string; status: CallInviteStatus; invited_by: string };

export type CallOut = {
  id: string;
  workspace_id: string;
  channel_id: string;
  kind: CallKind;
  status: CallStatus;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  /** Currently in the LiveKit room (per the huddle registry). */
  participant_ids: string[];
  /** Everyone who ever joined (the caller included). */
  joined_ids: string[];
  invites: CallInvite[];
  /** The call card system message in the channel. */
  message_id: string | null;
};

/** LiveKit connection details (same shape as POST /channels/{id}/huddle/join). */
export type CallJoin = { url: string; token: string; room: string };

/** POST /channels/{id}/calls and POST /calls/{id}/accept */
export type CallJoinResponse = { call: CallOut; join: CallJoin };

/** GET /me/calls/ringing row, and the payload of `call.ringing`. */
export type RingingCall = { call: CallOut; caller_id: string };

export type CallNotes = {
  call_id: string;
  /** TipTap JSON document. */
  content: Record<string, unknown> | null;
  version: number;
  updated_by: string | null;
  updated_at: string | null;
};

// --- System message meta ---
export type MessageKind = "user" | "system";

export type CallMessageMeta = {
  type: "call";
  call_id: string;
  kind: CallKind;
  status: CallStatus;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  joined_ids: string[];
  duration_s: number | null;
};

export type CallNotesMessageMeta = { type: "call_notes"; call_id: string };

export type SystemMessageMeta = CallMessageMeta | CallNotesMessageMeta | { type: string; [key: string]: unknown };

/** Message with the Stage 1 fields (until lib/api.ts Message carries them itself). */
export type MessageWithMeta = Message & { kind?: MessageKind; meta?: SystemMessageMeta | Record<string, unknown> | null };

// --- Realtime events ---
export type CallRingingEvent = { type: "call.ringing"; call: CallOut; caller_id: string };
export type CallRingStoppedEvent = {
  type: "call.ring_stopped";
  call_id: string;
  reason: "accepted" | "declined" | "missed" | "cancelled" | string;
};
export type CallUpdatedEvent = { type: "call.updated"; call: CallOut };
export type CallInviteUpdatedEvent = {
  type: "call.invite_updated";
  call_id: string;
  user_id: string;
  status: CallInviteStatus;
};
export type CallNotesUpdatedEvent = { type: "call.notes_updated"; call_id: string; notes: CallNotes };

export type CallRealtimeEvent =
  | CallRingingEvent
  | CallRingStoppedEvent
  | CallUpdatedEvent
  | CallInviteUpdatedEvent
  | CallNotesUpdatedEvent;

export function isCallLive(call: Pick<CallOut, "status"> | null | undefined): boolean {
  return !!call && (call.status === "ringing" || call.status === "active");
}

export function isCallMessageMeta(meta: unknown): meta is CallMessageMeta {
  return !!meta && typeof meta === "object" && (meta as { type?: unknown }).type === "call";
}

export function isCallNotesMeta(meta: unknown): meta is CallNotesMessageMeta {
  return !!meta && typeof meta === "object" && (meta as { type?: unknown }).type === "call_notes";
}
