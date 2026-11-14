/**
 * Framework-free recording engine: frame ticker, compositor, audio mixer, recorder and trimmer.
 * Nothing here touches React; the studio UI drives it.
 */

import { renderAnnotations, type AnnotationOp } from "@/components/annotate";
import { pickMimeType } from "@/components/voice/media";

export const MAX_RECORDING_MS = 15 * 60_000;
export const FPS = 30;
const MAX_WIDTH = 1920;
/** 15 min × (2.4 + 0.128) Mbps ≈ 285 MB, under the 300 MB upload limit. */
const VIDEO_BPS = 2_400_000;
const AUDIO_BPS = 128_000;

export type StudioMode = "screen" | "screen-camera" | "camera";
export type Corner = "tl" | "tr" | "bl" | "br";
/** Camera bubble: snapped corner and diameter as a fraction of the frame width. */
export type BubbleLayout = { corner: Corner; size: number };

export const BUBBLE_MIN = 0.1;
export const BUBBLE_MAX = 0.34;
export const BUBBLE_MARGIN = 0.025;

/** Centre of the bubble (normalised to the frame) for a layout. */
export function bubbleCenter(layout: BubbleLayout, aspect: number): { cx: number; cy: number; r: number; ry: number } {
  const r = layout.size / 2; // fraction of width
  const ry = r * aspect; // same radius as a fraction of height
  const mx = BUBBLE_MARGIN;
  const my = BUBBLE_MARGIN * aspect;
  const cx = layout.corner.endsWith("l") ? mx + r : 1 - mx - r;
  const cy = layout.corner.startsWith("t") ? my + ry : 1 - my - ry;
  return { cx, cy, r, ry };
}

export function nearestCorner(cx: number, cy: number): Corner {
  return `${cy < 0.5 ? "t" : "b"}${cx < 0.5 ? "l" : "r"}` as Corner;
}

/**
 * Interval ticker that keeps running in background tabs. Presenters usually switch to the tab or
 * window they are sharing, where requestAnimationFrame stops and setInterval is throttled to 1 Hz;
 * dedicated workers are not throttled that hard.
 */
export function startTicker(intervalMs: number, fn: () => void): () => void {
  let worker: Worker | null = null;
  let url: string | null = null;
  try {
    url = URL.createObjectURL(
      new Blob([`let id=setInterval(()=>postMessage(0),${intervalMs});onmessage=()=>{clearInterval(id);close()}`], {
        type: "text/javascript",
      }),
    );
    worker = new Worker(url);
    worker.onmessage = () => fn();
    return () => {
      worker?.postMessage("stop");
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
    };
  } catch {
    if (url) URL.revokeObjectURL(url);
    const id = window.setInterval(fn, intervalMs);
    return () => window.clearInterval(id);
  }
}

/** Upsert-by-id store of annotation ops fed by <Annotator send>. */
export class OpsStore {
  ops: AnnotationOp[] = [];
  private index = new Map<string, number>();

  upsert = (op: AnnotationOp) => {
    const i = this.index.get(op.id);
    if (i == null) {
      this.index.set(op.id, this.ops.length);
      this.ops.push(op);
    } else {
      this.ops[i] = op;
    }
    if (this.ops.length > 3000) this.compact();
  };

  reset() {
    this.ops = [];
    this.index.clear();
  }

  private compact() {
    // Keep the newest ops; very old ones have almost certainly been cleared or faded.
    this.ops = this.ops.slice(-2000);
    this.index = new Map(this.ops.map((op, i) => [op.id, i]));
  }
}

/** A detached, muted, playing <video> for a stream (frame source for the canvas). */
export function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.srcObject = stream;
  void v.play().catch(() => undefined);
  return v;
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, x: number, y: number, w: number, h: number) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
}

function drawContain(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, w: number, h: number) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Output size for a source: its own resolution capped at 1920 wide, even dimensions. */
export function outputSize(srcW: number, srcH: number): { width: number; height: number } {
  const w = srcW || 1280;
  const h = srcH || 720;
  const scale = Math.min(1, MAX_WIDTH / w);
  return { width: Math.round((w * scale) / 2) * 2, height: Math.round((h * scale) / 2) * 2 };
}

export type CompositorSources = {
  mode: StudioMode;
  screen?: MediaStream | null;
  camera?: MediaStream | null;
  width: number;
  height: number;
  getBubble: () => BubbleLayout;
  getOps: () => AnnotationOp[];
};

/** Paints screen + camera bubble + annotations into an offscreen canvas at 30 fps. */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  private ctx: CanvasRenderingContext2D;
  private screenVideo: HTMLVideoElement | null;
  private cameraVideo: HTMLVideoElement | null;
  private stopTicker: (() => void) | null = null;

  constructor(private src: CompositorSources) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = src.width;
    this.canvas.height = src.height;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas is not available");
    this.ctx = ctx;
    this.screenVideo = src.screen && src.mode !== "camera" ? videoFor(src.screen) : null;
    this.cameraVideo = src.camera && src.mode !== "screen" ? videoFor(src.camera) : null;
    this.draw();
    this.stream = this.canvas.captureStream(FPS);
    this.stopTicker = startTicker(Math.round(1000 / FPS), this.draw);
  }

  private draw = () => {
    const { ctx } = this;
    const { width: w, height: h, mode } = this.src;
    ctx.fillStyle = "#09090b";
    ctx.fillRect(0, 0, w, h);
    if (mode === "camera") {
      if (this.cameraVideo) {
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        drawCover(ctx, this.cameraVideo, 0, 0, w, h);
        ctx.restore();
      }
    } else {
      if (this.screenVideo) drawContain(ctx, this.screenVideo, w, h);
      if (mode === "screen-camera" && this.cameraVideo && this.cameraVideo.videoWidth) {
        const { cx, cy, r } = bubbleCenter(this.src.getBubble(), w / h);
        const px = cx * w;
        const py = cy * h;
        const pr = r * w;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = pr * 0.18;
        ctx.fillStyle = "#18181b";
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.clip();
        ctx.translate(px * 2, 0);
        ctx.scale(-1, 1);
        drawCover(ctx, this.cameraVideo, px - pr, py - pr, pr * 2, pr * 2);
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = Math.max(2, pr * 0.035);
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    renderAnnotations(ctx, this.src.getOps(), w, h, Date.now());
    // Some browsers only emit a frame from captureStream when the canvas changes; requestFrame forces it.
    const track = this.stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    track?.requestFrame?.();
  };

  dispose() {
    this.stopTicker?.();
    this.stopTicker = null;
    this.stream.getTracks().forEach((t) => t.stop());
    for (const v of [this.screenVideo, this.cameraVideo]) {
      if (!v) continue;
      v.pause();
      v.srcObject = null;
    }
    this.screenVideo = this.cameraVideo = null;
  }
}

/** Mixes mic + display audio into one track via WebAudio. */
export class AudioMixer {
  readonly ctx: AudioContext;
  readonly dest: MediaStreamAudioDestinationNode;
  readonly hasAudio: boolean;

  constructor(streams: (MediaStream | null | undefined)[]) {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    let connected = 0;
    for (const s of streams) {
      if (!s || !s.getAudioTracks().length) continue;
      this.ctx.createMediaStreamSource(s).connect(this.dest);
      connected++;
    }
    this.hasAudio = connected > 0;
    void this.ctx.resume().catch(() => undefined);
  }

  get tracks(): MediaStreamTrack[] {
    return this.hasAudio ? this.dest.stream.getAudioTracks() : [];
  }

  dispose() {
    this.dest.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => undefined);
  }
}

export function recorderFor(stream: MediaStream): MediaRecorder {
  const mimeType = pickMimeType("video");
  const opts: MediaRecorderOptions = { videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS };
  if (mimeType) opts.mimeType = mimeType;
  try {
    return new MediaRecorder(stream, opts);
  } catch {
    return new MediaRecorder(stream);
  }
}

/** Elapsed-time bookkeeping across pause/resume. */
export class Stopwatch {
  private acc = 0;
  private since: number | null = null;
  start() {
    this.acc = 0;
    this.since = performance.now();
  }
  pause() {
    if (this.since != null) this.acc += performance.now() - this.since;
    this.since = null;
  }
  resume() {
    if (this.since == null) this.since = performance.now();
  }
  get ms() {
    return this.acc + (this.since != null ? performance.now() - this.since : 0);
  }
}

/** One take: compositor + mixer + MediaRecorder. */
export class RecordingRun {
  readonly compositor: Compositor;
  readonly mixer: AudioMixer;
  readonly recorder: MediaRecorder;
  readonly watch = new Stopwatch();
  private chunks: Blob[] = [];
  private done: Promise<Blob>;

  constructor(sources: CompositorSources & { mic?: MediaStream | null }) {
    this.compositor = new Compositor(sources);
    this.mixer = new AudioMixer([sources.mic, sources.mode !== "camera" ? sources.screen : null]);
    const stream = new MediaStream([...this.compositor.stream.getVideoTracks(), ...this.mixer.tracks]);
    this.recorder = recorderFor(stream);
    this.done = new Promise<Blob>((resolve) => {
      this.recorder.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.recorder.mimeType || "video/webm" }));
    });
    this.recorder.start(1000);
    this.watch.start();
  }

  get state() {
    return this.recorder.state;
  }

  pause() {
    if (this.recorder.state !== "recording") return;
    this.recorder.pause();
    this.watch.pause();
  }

  resume() {
    if (this.recorder.state !== "paused") return;
    this.recorder.resume();
    this.watch.resume();
  }

  /** Stop and resolve the finished file. Safe to call twice. */
  stop(): Promise<Blob> {
    this.watch.pause();
    if (this.recorder.state !== "inactive") this.recorder.stop();
    return this.done.finally(() => this.dispose());
  }

  /** Stop and throw the take away. */
  discard() {
    this.recorder.ondataavailable = null;
    this.watch.pause();
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.dispose();
  }

  private dispose() {
    this.compositor.dispose();
    this.mixer.dispose();
  }
}

// --- Trim ---

function once(target: EventTarget, type: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Cancelled", "AbortError"));
    if (signal?.aborted) return onAbort();
    target.addEventListener(type, () => resolve(), { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * MediaRecorder WebM files have no duration/cues, so `duration` is Infinity and seeking is
 * unreliable until the browser has scanned to the end. Seeking far past the end forces that.
 */
export async function resolveDuration(video: HTMLVideoElement, signal?: AbortSignal): Promise<number> {
  if (video.readyState < 1) await once(video, "loadedmetadata", signal);
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  const changed = once(video, "durationchange", signal);
  video.currentTime = 1e101;
  await Promise.race([changed, new Promise((r) => setTimeout(r, 4000))]);
  const d = video.duration;
  video.currentTime = 0;
  return Number.isFinite(d) ? d : 0;
}

/**
 * Re-record [start, end] (seconds) of `src` at 1× through a canvas so the result is a real,
 * self-contained file. Rejects with AbortError when `signal` aborts.
 */
export async function trimRecording(
  src: string,
  start: number,
  end: number,
  { onProgress, signal }: { onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<Blob> {
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  let audio: AudioContext | null = null;
  let stopTicker: (() => void) | null = null;
  let recorder: MediaRecorder | null = null;
  try {
    await resolveDuration(video, signal);
    const { width, height } = outputSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas is not available");

    // Route the element's sound into the recording only (not the speakers).
    audio = new AudioContext();
    const dest = audio.createMediaStreamDestination();
    audio.createMediaElementSource(video).connect(dest);
    await audio.resume().catch(() => undefined);

    const seeked = once(video, "seeked", signal);
    video.currentTime = start;
    await seeked;

    const canvasStream = canvas.captureStream(FPS);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = recorderFor(stream);
    recorder = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    });

    const span = Math.max(0.1, end - start);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      video.pause();
      if (rec.state !== "inactive") rec.stop();
    };
    const draw = () => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      drawContain(ctx, video, width, height);
      const track = canvasStream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
      track?.requestFrame?.();
      onProgress?.(Math.min(1, Math.max(0, (video.currentTime - start) / span)));
      if (video.currentTime >= end || video.ended) finish();
    };
    draw();
    rec.start(1000);
    stopTicker = startTicker(Math.round(1000 / FPS), draw);
    video.addEventListener("ended", finish, { once: true });
    const abort = new Promise<never>((_, reject) => {
      const onAbort = () => {
        finish();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    await video.play();
    const blob = await Promise.race([stopped, abort]);
    onProgress?.(1);
    canvasStream.getTracks().forEach((t) => t.stop());
    return blob;
  } finally {
    stopTicker?.();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (audio) void audio.close().catch(() => undefined);
  }
}
