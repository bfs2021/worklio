import type { ConnectionQuality, VideoTrack } from "livekit-client";

export type HuddleStatus = "connecting" | "connected" | "reconnecting";

/** A channel's live huddle (GET /workspaces/{id}/huddles, mirrors HuddleOut). */
export type HuddleInfo = {
  channel_id: string;
  participant_ids: string[];
  started_at: string | null;
};

/** Realtime: a huddle's participants changed; an empty list means it ended. */
export type HuddleUpdatedEvent = HuddleInfo & { type: "huddle.updated" };

/** One person in the LiveKit room, flattened for rendering. */
export type HuddleParticipantView = {
  /** LiveKit identity == Worklio user id. */
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micEnabled: boolean;
  cameraTrack: VideoTrack | null;
  screenTrack: VideoTrack | null;
  quality: ConnectionQuality;
};

/** Immutable snapshot of the room, replaced (never mutated) on every LiveKit event. */
export type HuddleRoomSnapshot = {
  participants: HuddleParticipantView[];
  /** Identities currently speaking, loudest first. */
  speakingIds: string[];
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  quality: ConnectionQuality;
  /** False when the browser blocked autoplay; call `startAudio()` from a click to fix. */
  canPlayAudio: boolean;
};
