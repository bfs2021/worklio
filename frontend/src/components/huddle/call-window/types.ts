import type { JSONContent } from "@tiptap/react";

/**
 * Local copies of the Stage 1 call contract types. They are declared here (instead of imported
 * from the calls feature) so the call window compiles on its own while that feature lands.
 */
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
  participant_ids: string[];
  joined_ids: string[];
  invites: CallInvite[];
  message_id: string | null;
};

export type CallNotes = {
  call_id: string;
  content: JSONContent;
  version: number;
  updated_by: string | null;
  updated_at: string | null;
};

export type CallNotesSaveResult = { kind: "saved"; notes: CallNotes } | { kind: "conflict"; notes: CallNotes };

export type CallUpdatedEvent = { type: "call.updated"; call: CallOut };
export type CallNotesUpdatedEvent = { type: "call.notes_updated"; call_id: string; notes: CallNotes };

export type StageLayout = "grid" | "spotlight";
export type SidePanelTab = "people" | "chat" | "notes" | "transcript";

export const isLiveCall = (c: CallOut | null | undefined) => !!c && (c.status === "active" || c.status === "ringing");
