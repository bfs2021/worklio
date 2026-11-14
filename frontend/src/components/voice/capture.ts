/**
 * A framework-free recording session around getUserMedia + MediaRecorder.
 *
 * React components read it through `useSyncExternalStore(session.subscribe, session.getSnapshot)`;
 * the snapshot object only changes when something visible changes, so it is safe as a snapshot.
 * The stream is opened from a click/pointer handler (Safari wants a user gesture) and handed to
 * the UI, which calls `dispose()` when it is done.
 */

import { pickMimeType, toPeaks } from "./media";

export type CaptureStatus = "idle" | "recording" | "paused" | "stopped";

export type CaptureSnapshot = {
  status: CaptureStatus;
  elapsedMs: number;
  /** Object URL of the finished recording (status "stopped"). */
  url: string | null;
  blob: Blob | null;
  /** 48 normalised peaks of the finished recording (audio only). */
  peaks: number[];
  /** Why the last recording stopped. */
  stopReason: "user" | "max" | null;
};

const TICK_MS = 50;
/** Level samples kept for the live waveform / peaks (5 min at 20 Hz = 6000). */
const MAX_LEVELS = 6000;

export class RecordingSession {
  readonly stream: MediaStream;
  readonly kind: "audio" | "video";
  readonly maxMs: number;
  /** Level history (0–1), one sample per tick while recording. Read directly by canvases. */
  readonly levels: number[] = [];

  private recorder: MediaRecorder | null = null;
  private segmentStart = 0;
  private accumulated = 0;
  private timer: number | null = null;
  private ticks = 0;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleBuf: Uint8Array<ArrayBuffer> | null = null;
  private listeners = new Set<() => void>();
  private stopWaiters: ((blob: Blob | null) => void)[] = [];
  private disposed = false;
  private snapshot: CaptureSnapshot = {
    status: "idle",
    elapsedMs: 0,
    url: null,
    blob: null,
    peaks: [],
    stopReason: null,
  };

  private constructor(stream: MediaStream, kind: "audio" | "video", maxMs: number) {
    this.stream = stream;
    this.kind = kind;
    this.maxMs = maxMs;
    if (kind === "audio") this.setupAnalyser();
  }

  /** Ask for the mic (and camera for video). Throws the getUserMedia error for the caller to report. */
  static async open(kind: "audio" | "video", maxMs: number): Promise<RecordingSession> {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("MediaRecorder unsupported", "NotSupportedError");
    }
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === "audio"
        ? { audio }
        : {
            audio,
            video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          },
    );
    return new RecordingSession(stream, kind, maxMs);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private setupAnalyser() {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      source.connect(this.analyser);
      this.sampleBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    } catch {
      this.audioCtx = null;
      this.analyser = null;
    }
  }

  /** Current input level 0–1 (RMS, lightly expanded so speech fills the range). */
  level(): number {
    if (!this.analyser || !this.sampleBuf) return 0;
    this.analyser.getByteTimeDomainData(this.sampleBuf);
    let sum = 0;
    for (let i = 0; i < this.sampleBuf.length; i++) {
      const v = (this.sampleBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.sampleBuf.length);
    return Math.min(1, rms * 3.2);
  }

  elapsed(): number {
    const running = this.snapshot.status === "recording" ? performance.now() - this.segmentStart : 0;
    return Math.min(this.maxMs, this.accumulated + running);
  }

  /** Start (or restart, discarding the previous take) recording. */
  start() {
    if (this.disposed) return;
    this.resetTake();
    let mimeType = pickMimeType(this.kind);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, {
        ...(mimeType ? { mimeType } : {}),
        ...(this.kind === "audio" ? { audioBitsPerSecond: 64_000 } : { videoBitsPerSecond: 2_000_000 }),
      });
    } catch {
      // Some engines reject a type/bitrate combo isTypeSupported() accepted: let the browser pick.
      mimeType = undefined;
      recorder = new MediaRecorder(this.stream);
    }
    this.recorder = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (this.recorder !== recorder) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || (this.kind === "audio" ? "audio/webm" : "video/webm") });
      const url = this.disposed ? null : URL.createObjectURL(blob);
      if (!this.disposed) this.set({ status: "stopped", blob, url, peaks: this.kind === "audio" ? toPeaks(this.levels) : [] });
      const waiters = this.stopWaiters;
      this.stopWaiters = [];
      waiters.forEach((w) => w(blob));
    };
    void this.audioCtx?.resume().catch(() => undefined);
    try {
      recorder.start(250);
    } catch {
      // Older Safari throws for a timeslice on some streams; record in one chunk instead.
      recorder.start();
    }
    this.segmentStart = performance.now();
    this.accumulated = 0;
    this.set({ status: "recording", elapsedMs: 0, stopReason: null });
    this.startTimer();
  }

  pause() {
    if (this.snapshot.status !== "recording" || !this.recorder) return;
    this.accumulated += performance.now() - this.segmentStart;
    try {
      this.recorder.pause();
    } catch {
      /* Some browsers lack pause(); the elapsed clock still stops. */
    }
    this.set({ status: "paused", elapsedMs: this.elapsed() });
  }

  resume() {
    if (this.snapshot.status !== "paused" || !this.recorder) return;
    try {
      this.recorder.resume();
    } catch {
      /* ignore */
    }
    this.segmentStart = performance.now();
    this.set({ status: "recording" });
  }

  /** Finish the take. Resolves with the recording (or null if nothing was recorded). */
  stop(reason: "user" | "max" = "user"): Promise<Blob | null> {
    const { status } = this.snapshot;
    if (status === "stopped") return Promise.resolve(this.snapshot.blob);
    if (!this.recorder || status === "idle") return Promise.resolve(null);
    if (status === "recording") this.accumulated += performance.now() - this.segmentStart;
    this.stopTimer();
    // Keep the final elapsed time, then wait for the recorder to flush its last chunk.
    this.snapshot = { ...this.snapshot, elapsedMs: Math.min(this.maxMs, this.accumulated), stopReason: reason };
    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      try {
        this.recorder?.requestData();
      } catch {
        /* ignore */
      }
      try {
        this.recorder?.stop();
      } catch {
        resolve(null);
      }
    });
  }

  /** Throw away the current take but keep the devices open (re-record). */
  resetTake() {
    if (this.recorder && this.recorder.state !== "inactive") {
      const old = this.recorder;
      this.recorder = null;
      try {
        old.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    this.stopTimer();
    if (this.snapshot.url) URL.revokeObjectURL(this.snapshot.url);
    this.levels.length = 0;
    this.accumulated = 0;
    this.stopWaiters.forEach((w) => w(null));
    this.stopWaiters = [];
    if (!this.disposed) this.set({ status: "idle", elapsedMs: 0, url: null, blob: null, peaks: [], stopReason: null });
  }

  /** Stop the devices and free everything. Safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.resetTake();
    this.disposed = true;
    this.stream.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.listeners.clear();
  }

  get isDisposed() {
    return this.disposed;
  }

  private startTimer() {
    this.stopTimer();
    this.ticks = 0;
    this.timer = window.setInterval(() => {
      if (this.snapshot.status !== "recording") return;
      if (this.analyser) {
        this.levels.push(this.level());
        if (this.levels.length > MAX_LEVELS) this.levels.splice(0, this.levels.length - MAX_LEVELS);
      }
      const elapsed = this.elapsed();
      if (elapsed >= this.maxMs) {
        void this.stop("max");
        return;
      }
      // Re-render subscribers ~10×/s: enough for a smooth clock and progress ring.
      if (++this.ticks % 2 === 0) this.set({ elapsedMs: elapsed });
    }, TICK_MS);
  }

  private stopTimer() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }
}

const pendingDispose = new WeakMap<RecordingSession, number>();

/**
 * Keep a session alive while a component is mounted: `useEffect(() => retainSession(s), [s])`.
 * Disposal is deferred one task so React Strict Mode's mount → unmount → mount check
 * (whose re-mount cancels the pending dispose) doesn't kill the microphone.
 */
export function retainSession(session: RecordingSession): () => void {
  const pending = pendingDispose.get(session);
  if (pending != null) {
    window.clearTimeout(pending);
    pendingDispose.delete(session);
  }
  return () => {
    pendingDispose.set(
      session,
      window.setTimeout(() => {
        pendingDispose.delete(session);
        session.dispose();
      }, 0),
    );
  };
}
