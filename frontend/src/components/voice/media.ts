/**
 * Shared helpers for recording and playing voice messages and video clips.
 * Nothing here touches React; the recorder sessions live in ./capture.ts.
 */

import { ApiError, api, type AttachmentKind, type Message, uploadFile } from "@/lib/api";

export const VOICE_MAX_MS = 5 * 60_000;
export const VIDEO_MAX_MS = 2 * 60_000;
/** Bars stored with a voice message (the API accepts up to 64). */
export const WAVEFORM_BARS = 48;
export const PLAYBACK_RATES = [1, 1.5, 2] as const;

const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
];

/** Best container the browser can record (Opus/WebM on Chromium + Firefox, MP4 on Safari). */
export function pickMimeType(kind: "audio" | "video"): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const list = kind === "audio" ? AUDIO_TYPES : VIDEO_TYPES;
  return list.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Readable reason for a getUserMedia / MediaRecorder failure. */
export function mediaErrorMessage(err: unknown, device: "microphone" | "camera"): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return `${device === "camera" ? "Camera" : "Microphone"} access is blocked. Allow it in your browser's site settings and try again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${device} found. Connect one and try again.`;
    case "NotReadableError":
    case "AbortError":
      return `Your ${device} is being used by another app.`;
    default:
      if (!canRecord()) return "Recording isn't supported in this browser.";
      return `Couldn't start the ${device}.`;
  }
}

/** "m:ss" (or "h:mm:ss"). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Spoken-friendly duration for aria labels: "1 minute 5 seconds". */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts = [];
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/** Down-sample a level history into `bars` peaks normalised to 0–100 (loudest = 100). */
export function toPeaks(levels: number[], bars = WAVEFORM_BARS): number[] {
  if (!levels.length) return Array.from({ length: bars }, () => 8);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * levels.length) / bars);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  const max = Math.max(...out, 0.0001);
  // A gentle curve keeps quiet speech visible without flattening loud parts.
  return out.map((v) => Math.max(4, Math.min(100, Math.round(Math.pow(v / max, 0.7) * 100))));
}

/** Deterministic, natural-looking waveform for audio that has none stored (e.g. uploaded mp3s). */
export function fallbackWaveform(seed: string, bars = WAVEFORM_BARS): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const rnd = ((h >>> 0) % 1000) / 1000;
    const envelope = 0.55 + 0.45 * Math.sin((i / bars) * Math.PI);
    out.push(Math.round(18 + rnd * 70 * envelope));
  }
  return out;
}

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return mime.startsWith("audio") ? "m4a" : "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

export function recordingFile(blob: Blob, kind: AttachmentKind): File {
  // Drop codec parameters; the API stores the bare media type.
  const type = (blob.type || (kind === "voice" ? "audio/webm" : "video/webm")).split(";")[0];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const name = `${kind === "voice" ? "Voice message" : "Video clip"} ${stamp}.${extensionFor(type)}`.replace(/ /g, "_");
  return new File([blob], name, { type });
}

/** Upload a recording and post it as a message (works for channels and threads). */
export async function sendRecording(opts: {
  workspaceId: string;
  channelId: string;
  parentId?: string;
  blob: Blob;
  kind: AttachmentKind;
  durationMs: number;
  waveform?: number[];
}): Promise<Message> {
  const file = recordingFile(opts.blob, opts.kind);
  const attachment = await uploadFile(opts.workspaceId, file, {
    kind: opts.kind,
    duration_ms: Math.min(600_000, Math.max(0, Math.round(opts.durationMs))),
    waveform: opts.waveform,
  });
  return api<Message>(`/channels/${opts.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: "", parent_id: opts.parentId ?? null, attachment_ids: [attachment.id] }),
  });
}

export function sendErrorMessage(err: unknown, what: string): string {
  if (err instanceof ApiError && err.status === 413) return `${what} is too large to send.`;
  if (err instanceof Error && err.message) return `Couldn't send ${what.toLowerCase()}: ${err.message}`;
  return `Couldn't send ${what.toLowerCase()}.`;
}

/** Is this attachment a playable voice message / audio file? */
export function isAudioAttachment(a: { kind?: string | null; content_type: string }): boolean {
  return a.kind === "voice" || (a.kind == null && a.content_type.startsWith("audio/"));
}

export function isVideoAttachment(a: { kind?: string | null; content_type: string }): boolean {
  return a.kind === "video_clip" || (a.kind == null && a.content_type.startsWith("video/"));
}
