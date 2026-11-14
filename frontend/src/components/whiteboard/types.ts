/** Opaque Excalidraw element as stored by the backend (validated to carry `id` + `version`). */
export type WhiteboardElement = { id: string; version: number; [key: string]: unknown };

/** GET/PUT /channels/{id}/whiteboard */
export type Whiteboard = {
  channel_id: string;
  elements: WhiteboardElement[];
  version: number;
  updated_by: string | null;
  updated_at: string;
};

export type WhiteboardSaveResult =
  | { kind: "saved"; whiteboard: Whiteboard }
  | { kind: "conflict"; whiteboard: Whiteboard };

/** Client → server WebSocket frames. */
export type WhiteboardOpsFrame = {
  type: "whiteboard.ops";
  channel_id: string;
  client_id: string;
  elements: WhiteboardElement[];
};
export type WhiteboardPointerFrame = {
  type: "whiteboard.pointer";
  channel_id: string;
  client_id: string;
  x: number;
  y: number;
  tool?: "pointer" | "laser";
};

/** Server → client events (published to the channel topic). */
export type WhiteboardRealtimeEvent =
  | { type: "whiteboard.ops"; channel_id: string; user_id: string; client_id: string; elements: unknown[] }
  | {
      type: "whiteboard.pointer";
      channel_id: string;
      user_id: string;
      client_id: string;
      x: number;
      y: number;
      tool?: "pointer" | "laser" | null;
    };

export type SaveStatus = "saved" | "saving" | "offline" | "error" | "readonly";

/** Someone recently active on the board (pointer or edits). */
export type WhiteboardPeer = { userId: string; lastSeen: number };
