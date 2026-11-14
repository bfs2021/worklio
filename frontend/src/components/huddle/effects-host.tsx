"use client";

import type { LocalVideoTrack } from "livekit-client";

import { EffectsDialog } from "@/components/effects/effects-panel";

import { useHuddleRoom, useHuddles } from "./huddle-provider";
import { usePreJoinOpen } from "./pre-join";

/**
 * Renders the camera Effects panel for the call I'm in. Mount exactly one at a time: inside the
 * call window while it's open (so it nests in that modal), otherwise from <HuddleBar>.
 */
export function EffectsDialogHost() {
  const { room } = useHuddles();
  const snap = useHuddleRoom();
  const preJoinOpen = usePreJoinOpen();
  const cameraTrack = (snap.participants.find((p) => p.isLocal)?.cameraTrack ?? null) as LocalVideoTrack | null;
  // The "Ready to join?" check renders its own panel on its preview track.
  if (preJoinOpen) return null;
  return <EffectsDialog room={room} cameraTrack={cameraTrack} />;
}
