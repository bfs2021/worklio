"use client";

import {
  Camera,
  Circle,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  MonitorUp,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  Scissors,
  SendHorizontal,
  Square,
  Volume2,
  X,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { Annotator, type AnnotateUser } from "@/components/annotate";
import { formatClock, mediaErrorMessage } from "@/components/voice/media";
import type { Message } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import {
  type BubbleLayout,
  MAX_RECORDING_MS,
  OpsStore,
  outputSize,
  RecordingRun,
  resolveDuration,
  type StudioMode,
  trimRecording,
} from "./engine";
import { CameraBubble, MicMeter, StreamVideo } from "./stage";
import { TrimBar } from "./trim-bar";
import { sendFailureMessage, sendScreenRecording } from "./upload";

type Step = "setup" | "countdown" | "recording" | "review" | "trimming" | "sending";
type Take = { blob: Blob; url: string; durationMs: number };

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

export function canShareScreen(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function";
}

export function canRecordClips(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

/** Tab/system audio capture is a Chromium feature. */
function systemAudioSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Chrome|Chromium|Edg\//.test(ua) && !/Firefox|FxiOS/.test(ua) && !/Mobile/.test(ua);
}

function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

function formatBytes(n: number) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const MODES: { id: StudioMode; label: string; icon: typeof Monitor; needsScreen: boolean }[] = [
  { id: "screen", label: "Screen", icon: Monitor, needsScreen: true },
  { id: "screen-camera", label: "Screen + camera", icon: MonitorUp, needsScreen: true },
  { id: "camera", label: "Camera only", icon: Camera, needsScreen: false },
];

export type RecordingStudioProps = {
  workspaceId: string;
  channelId: string;
  parentId?: string;
  user: AnnotateUser;
  onSent?: (m: Message) => void;
  onClose: () => void;
  /** Set to true while closing would lose work (recording in progress or an unsent take). */
  busyRef?: RefObject<boolean>;
};

/**
 * Loom-style recorder: screen / screen + camera bubble / camera, mic + system audio, live
 * annotations, pause/restart, trim, send. Mount it only while open; unmounting releases every
 * device, object URL and audio context.
 */
export function RecordingStudio({ workspaceId, channelId, parentId, user, onSent, onClose, busyRef }: RecordingStudioProps) {
  const [screenOk] = useState(canShareScreen);
  const [sysAudioOk] = useState(systemAudioSupported);
  const [step, setStep] = useState<Step>("setup");
  const [mode, setMode] = useState<StudioMode>(screenOk ? "screen-camera" : "camera");
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [mic, setMic] = useState<MediaStream | null>(null);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>("default");
  const [systemAudio, setSystemAudio] = useState(sysAudioOk);
  const [bubble, setBubble] = useState<BubbleLayout>({ corner: "br", size: 0.2 });
  const [count, setCount] = useState(3);
  const [run, setRun] = useState<RecordingRun | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [takeNo, setTakeNo] = useState(0);
  const [take, setTake] = useState<Take | null>(null);
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [store] = useState(() => new OpsStore());

  const player = useRef<HTMLVideoElement>(null);
  const bubbleRef = useRef(bubble);
  const aborts = useRef<{ trim: AbortController | null; send: AbortController | null }>({ trim: null, send: null });
  const stopRef = useRef<() => void>(() => undefined);

  const wantsScreen = mode !== "camera";
  const wantsCamera = mode !== "screen" && (step === "setup" || step === "countdown" || step === "recording");
  const wantsMic = micId !== "none" && (step === "setup" || step === "countdown" || step === "recording");
  const live = step === "countdown" || step === "recording";

  useEffect(() => {
    bubbleRef.current = bubble;
  }, [bubble]);

  useEffect(() => {
    if (busyRef) busyRef.current = step === "recording" || step === "countdown" || step === "trimming" || step === "sending" || !!take;
  }, [busyRef, step, take]);

  // --- Devices ---
  useEffect(() => {
    if (!wantsCamera) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setCamera(s);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(mediaErrorMessage(err, "camera"));
        setMode((m) => (m === "camera" ? (canShareScreen() ? "screen" : m) : "screen"));
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [wantsCamera]);

  useEffect(() => {
    if (!wantsMic) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (micId !== "default") audio.deviceId = { exact: micId };
    navigator.mediaDevices
      .getUserMedia({ audio, video: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setMic(s);
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!cancelled) setMics(devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default"));
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(mediaErrorMessage(err, "microphone"));
        setMicId("none");
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [wantsMic, micId]);

  // Screen: picked from a click (browsers require a gesture). Stopped when replaced or unmounted.
  useEffect(() => {
    if (!screen) return;
    const track = screen.getVideoTracks()[0];
    const onEnded = () => stopRef.current();
    track?.addEventListener("ended", onEnded);
    return () => {
      track?.removeEventListener("ended", onEnded);
      screen.getTracks().forEach((t) => t.stop());
    };
  }, [screen]);

  const chooseScreen = async (): Promise<MediaStream | null> => {
    try {
      const options = {
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 3840 }, height: { max: 2160 } },
        audio: systemAudio && sysAudioOk,
        systemAudio: systemAudio ? "include" : "exclude",
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions;
      const s = await navigator.mediaDevices.getDisplayMedia(options);
      if (systemAudio && sysAudioOk && !s.getAudioTracks().length) {
        toast.info("No computer audio is being shared. Tick “Share audio” in the browser picker to include it.");
      }
      setScreen(s);
      return s;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "AbortError") toast.info("Screen sharing was cancelled.");
      else toast.error("Couldn't start screen sharing.");
      return null;
    }
  };

  // --- Recording ---
  const begin = () => {
    const screenTrack = screen?.getVideoTracks()[0];
    const camTrack = camera?.getVideoTracks()[0];
    const src = mode === "camera" ? camTrack?.getSettings() : screenTrack?.getSettings();
    const { width, height } = outputSize(src?.width ?? 1280, src?.height ?? 720);
    try {
      const r = new RecordingRun({
        mode,
        screen: mode === "camera" ? null : screen,
        camera: mode === "screen" ? null : camera,
        mic: micId === "none" ? null : mic,
        width,
        height,
        getBubble: () => bubbleRef.current,
        getOps: () => store.ops,
      });
      setRun(r);
      setPaused(false);
      setElapsed(0);
      setStep("recording");
    } catch (err) {
      toast.error(err instanceof Error && err.message ? `Couldn't start recording: ${err.message}` : "Couldn't start recording.");
      setStep("setup");
    }
  };

  const start = async () => {
    if (wantsScreen && !screen) {
      const s = await chooseScreen();
      if (!s) return;
    }
    if (mode !== "screen" && !camera) {
      toast.info("Waiting for the camera…");
      return;
    }
    store.reset();
    setTakeNo((n) => n + 1);
    setCount(3);
    setStep("countdown");
  };

  const beginRef = useRef(begin);
  useEffect(() => {
    beginRef.current = begin;
  });

  // 3-2-1 countdown.
  useEffect(() => {
    if (step !== "countdown") return;
    const id = window.setTimeout(() => {
      if (count > 1) setCount(count - 1);
      else beginRef.current();
    }, 1000);
    return () => window.clearTimeout(id);
  }, [step, count]);

  // Timer + 15 min cap.
  useEffect(() => {
    if (step !== "recording" || !run) return;
    const id = window.setInterval(() => {
      const ms = run.watch.ms;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) {
        toast.info("Recordings can be up to 15 minutes.");
        stopRef.current();
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [step, run]);

  // Throw an in-flight take away on unmount.
  useEffect(() => {
    if (!run) return;
    return () => {
      if (run.state !== "inactive") run.discard();
    };
  }, [run]);

  const stop = async () => {
    if (!run) {
      // Sharing ended before recording started.
      if (step === "countdown") setStep("setup");
      setScreen(null);
      return;
    }
    const ms = run.watch.ms;
    setDrawing(false);
    setStep("review");
    const blob = await run.stop();
    setRun(null);
    setScreen(null);
    if (!blob.size || ms < 800) {
      toast.info("That recording was too short.");
      setStep("setup");
      return;
    }
    setTake({ blob, url: URL.createObjectURL(blob), durationMs: ms });
    setTitle("");
  };

  useEffect(() => {
    stopRef.current = () => void stop();
  });

  const togglePause = () => {
    if (!run) return;
    if (paused) run.resume();
    else run.pause();
    setPaused(!paused);
  };

  const restart = () => {
    run?.discard();
    setRun(null);
    setDrawing(false);
    store.reset();
    setTakeNo((n) => n + 1);
    setCount(3);
    setStep("countdown");
  };

  const cancelCountdown = () => setStep("setup");

  // --- Review ---
  useEffect(() => {
    if (!take) return;
    const url = take.url;
    return () => URL.revokeObjectURL(url);
  }, [take]);

  useEffect(() => {
    const el = player.current;
    if (!take || !el) return;
    const ac = new AbortController();
    resolveDuration(el, ac.signal)
      .then((d) => {
        const secs = d > 0 ? d : take.durationMs / 1000;
        setDuration(secs);
        setRange({ start: 0, end: secs });
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [take]);

  // Abort trims/uploads on unmount.
  useEffect(() => {
    const a = aborts.current;
    return () => {
      a.trim?.abort();
      a.send?.abort();
    };
  }, []);

  const trimmed = !!range && duration > 0 && (range.start > 0.25 || range.end < duration - 0.25);

  const applyTrim = async (): Promise<Take | null> => {
    if (!take || !range) return take;
    const ac = new AbortController();
    aborts.current.trim = ac;
    setProgress(0);
    setStep("trimming");
    try {
      const blob = await trimRecording(take.url, range.start, range.end, { onProgress: setProgress, signal: ac.signal });
      const next = { blob, url: URL.createObjectURL(blob), durationMs: Math.round((range.end - range.start) * 1000) };
      setTake(next);
      setStep("review");
      return next;
    } catch (err) {
      if (!isAbort(err)) toast.error("Couldn't trim the recording.");
      setStep("review");
      return null;
    } finally {
      aborts.current.trim = null;
    }
  };

  const send = async () => {
    let current = take;
    if (!current) return;
    if (trimmed) {
      current = await applyTrim();
      if (!current) return;
    }
    if (current.blob.size > MAX_UPLOAD_BYTES) {
      toast.error("This recording is larger than 300 MB. Trim it to send.");
      return;
    }
    const ac = new AbortController();
    aborts.current.send = ac;
    setProgress(0);
    setStep("sending");
    try {
      const msg = await sendScreenRecording({
        workspaceId,
        channelId,
        parentId,
        blob: current.blob,
        durationMs: current.durationMs,
        title,
        onProgress: setProgress,
        signal: ac.signal,
      });
      if (busyRef) busyRef.current = false;
      toast.success("Recording sent");
      onSent?.(msg);
      onClose();
    } catch (err) {
      if (!isAbort(err)) toast.error(sendFailureMessage(err));
      setStep("review");
    } finally {
      aborts.current.send = null;
    }
  };

  const discardTake = () => {
    setTake(null);
    setRange(null);
    setDuration(0);
    setStep("setup");
  };

  // Keep playback inside the trim range.
  const onTimeUpdate = () => {
    const el = player.current;
    if (!el || !range || !trimmed) return;
    if (el.currentTime >= range.end) {
      el.pause();
      el.currentTime = range.start;
    } else if (el.currentTime < range.start - 0.05) {
      el.currentTime = range.start;
    }
  };

  // D toggles drawing while live.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey && !e.altKey && !drawing) {
        e.preventDefault();
        setDrawing(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, drawing]);

  // --- Stage geometry ---
  const srcSettings = (mode === "camera" ? camera : screen)?.getVideoTracks()[0]?.getSettings();
  const aspect = srcSettings?.width && srcSettings?.height ? srcSettings.width / srcSettings.height : 16 / 9;
  const remaining = Math.max(0, MAX_RECORDING_MS - elapsed);

  const reviewing = step === "review" || step === "trimming" || step === "sending";

  return (
    <div className="flex min-h-0 flex-col">
      {/* Stage */}
      <div className="relative flex items-center justify-center bg-black px-3 py-3 sm:px-4">
        {reviewing && take ? (
          <video
            ref={player}
            key={take.url}
            src={take.url}
            controls
            playsInline
            onTimeUpdate={onTimeUpdate}
            aria-label="Recording preview"
            className="max-h-[52dvh] w-full rounded-lg bg-black object-contain"
          />
        ) : reviewing ? (
          <div className="flex aspect-video max-h-[52dvh] w-full items-center justify-center text-sm text-zinc-400">
            <Loader2 className="mr-2 size-4 motion-safe:animate-spin" /> Finishing recording…
          </div>
        ) : (
          <div
            className="relative overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/10"
            style={{ aspectRatio: String(aspect), width: `min(100%, calc(52dvh * ${aspect.toFixed(4)}))` }}
          >
            {mode === "camera" ? (
              camera ? (
                <StreamVideo stream={camera} mirrored label="Camera preview" />
              ) : (
                <Placeholder icon={Camera} text="Starting camera…" busy />
              )
            ) : screen ? (
              <StreamVideo stream={screen} fit="contain" label="Screen preview" />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
                  <Monitor className="size-6 text-zinc-300" />
                </span>
                <p className="max-w-xs text-sm text-zinc-300">Pick a screen, window or tab to preview it here.</p>
                <button
                  type="button"
                  onClick={() => void chooseScreen()}
                  className="h-8 rounded-lg bg-white px-3 text-sm font-semibold text-zinc-900 outline-none hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  Choose what to share
                </button>
              </div>
            )}

            {mode === "screen-camera" && camera && (
              <CameraBubble stream={camera} layout={bubble} aspect={aspect} onLayout={setBubble} interactive={!drawing} />
            )}

            {live && (
              <Annotator
                key={takeNo}
                active={drawing}
                onActiveChange={setDrawing}
                user={user}
                send={store.upsert}
                autoFadeDefault
              />
            )}

            {step === "countdown" && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/55 backdrop-blur-[2px]" aria-live="assertive">
                <span
                  key={count}
                  className="flex size-28 items-center justify-center rounded-full bg-white/10 text-6xl font-bold text-white tabular-nums ring-2 ring-white/40 motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in-0"
                >
                  {count}
                </span>
                <button
                  type="button"
                  onClick={cancelCountdown}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/80 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Cancel
                </button>
              </div>
            )}

            {step === "recording" && (
              <span className="absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white tabular-nums ring-1 ring-white/10 backdrop-blur">
                <span className={cn("size-2 rounded-full", paused ? "bg-amber-400" : "bg-red-500 motion-safe:animate-pulse")} />
                {paused ? "Paused" : "REC"} {formatClock(elapsed)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="border-t border-white/10 px-4 py-3">
        {step === "setup" && (
          <SetupControls
            mode={mode}
            onMode={(m) => {
              setMode(m);
              if (m === "camera") setScreen(null);
            }}
            screenOk={screenOk}
            hasScreen={!!screen}
            onChooseScreen={() => void chooseScreen()}
            mics={mics}
            micId={micId}
            onMicId={setMicId}
            mic={micId === "none" ? null : mic}
            sysAudioOk={sysAudioOk}
            systemAudio={systemAudio}
            onSystemAudio={setSystemAudio}
            onStart={() => void start()}
            onCancel={onClose}
          />
        )}

        {(step === "countdown" || step === "recording") && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <p className="text-sm font-semibold text-white tabular-nums">
                {formatClock(elapsed)} <span className="font-normal text-zinc-500">/ {formatClock(MAX_RECORDING_MS)}</span>
              </p>
              <p className="text-xs text-zinc-400">
                {remaining < 60_000 ? `${Math.ceil(remaining / 1000)}s left` : "Keeps recording if you switch tabs. Stopping sharing ends it."}
              </p>
            </div>
            <CtlButton label={drawing ? "Stop drawing" : "Draw on screen"} shortcut="D" pressed={drawing} onClick={() => setDrawing(!drawing)} disabled={step !== "recording"}>
              <PenLine className="size-4" />
              <span className="max-sm:sr-only">Draw</span>
            </CtlButton>
            <CtlButton label={paused ? "Resume" : "Pause"} onClick={togglePause} disabled={step !== "recording"}>
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              <span className="max-sm:sr-only">{paused ? "Resume" : "Pause"}</span>
            </CtlButton>
            <CtlButton label="Restart recording" onClick={restart} disabled={step !== "recording"}>
              <RotateCcw className="size-4" />
              <span className="max-sm:sr-only">Restart</span>
            </CtlButton>
            <button
              type="button"
              onClick={() => (step === "countdown" ? cancelCountdown() : void stop())}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-red-500 px-3.5 text-sm font-semibold text-white outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-300"
            >
              <Square className="size-3.5 fill-current" />
              {step === "countdown" ? "Cancel" : "Stop"}
            </button>
          </div>
        )}

        {reviewing && (
          <div className="flex flex-col gap-3">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 200))}
              placeholder="Add a title (optional)"
              aria-label="Recording title"
              disabled={step !== "review"}
              className="h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-zinc-500 focus-visible:border-sky-400/60 focus-visible:ring-2 focus-visible:ring-sky-400/30"
            />
            {range && duration > 1.5 && (
              <TrimBar
                duration={duration}
                start={range.start}
                end={range.end}
                disabled={step !== "review"}
                onChange={(s, e) => setRange({ start: s, end: e })}
                onScrub={(t) => {
                  if (player.current) player.current.currentTime = t;
                }}
              />
            )}
            {(step === "trimming" || step === "sending") && (
              <div className="flex items-center gap-3" role="status" aria-live="polite">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-sky-400 transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <span className="w-40 shrink-0 text-xs text-zinc-300 tabular-nums">
                  {step === "trimming" ? `Trimming… ${Math.round(progress * 100)}%` : `Uploading… ${Math.round(progress * 100)}%`}
                </span>
                <button
                  type="button"
                  onClick={() => (step === "trimming" ? aborts.current.trim?.abort() : aborts.current.send?.abort())}
                  className="h-8 rounded-lg px-3 text-sm font-medium text-zinc-300 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
                >
                  Cancel
                </button>
              </div>
            )}
            {step === "review" && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="mr-auto text-xs text-zinc-400 tabular-nums">
                  {take ? `${formatClock(take.durationMs)} · ${formatBytes(take.blob.size)}` : "Preparing…"}
                  {trimmed && range ? ` · sending ${formatClock((range.end - range.start) * 1000)}` : ""}
                </p>
                <button
                  type="button"
                  onClick={discardTake}
                  className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-300 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
                >
                  <RotateCcw className="size-4" />
                  Re-record
                </button>
                {trimmed && (
                  <button
                    type="button"
                    onClick={() => void applyTrim()}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-white/15 px-3 text-sm font-medium text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50"
                  >
                    <Scissors className="size-4" />
                    Apply trim
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!take}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-white outline-none hover:bg-sky-600 focus-visible:ring-2 focus-visible:ring-sky-300 disabled:opacity-50"
                >
                  <SendHorizontal className="size-4" />
                  Send
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Placeholder({ icon: Icon, text, busy }: { icon: typeof Monitor; text: string; busy?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-400">
      {busy ? <Loader2 className="size-5 motion-safe:animate-spin" /> : <Icon className="size-6" />}
      {text}
    </div>
  );
}

function CtlButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-sm font-medium text-zinc-100 outline-none",
        "hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-40",
        pressed && "border-sky-400/50 bg-sky-500/20 text-sky-100",
      )}
    >
      {children}
    </button>
  );
}

function SetupControls(p: {
  mode: StudioMode;
  onMode: (m: StudioMode) => void;
  screenOk: boolean;
  hasScreen: boolean;
  onChooseScreen: () => void;
  mics: MediaDeviceInfo[];
  micId: string;
  onMicId: (id: string) => void;
  mic: MediaStream | null;
  sysAudioOk: boolean;
  systemAudio: boolean;
  onSystemAudio: (v: boolean) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  const onModeKey = (e: React.KeyboardEvent, i: number) => {
    const enabled = MODES.filter((m) => !m.needsScreen || p.screenOk);
    const idx = enabled.findIndex((m) => m.id === MODES[i].id);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = enabled[(idx + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
      p.onMode(next.id);
      (e.currentTarget.parentElement?.querySelector(`[data-mode="${next.id}"]`) as HTMLElement | null)?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="What to record" className="grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1 ring-1 ring-white/10">
        {MODES.map((m, i) => {
          const disabled = m.needsScreen && !p.screenOk;
          const checked = p.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              data-mode={m.id}
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              title={disabled ? "Screen recording isn't supported on this device" : undefined}
              onClick={() => p.onMode(m.id)}
              onKeyDown={(e) => onModeKey(e, i)}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold outline-none transition-colors sm:text-sm",
                "focus-visible:ring-2 focus-visible:ring-sky-400/70 disabled:opacity-40",
                checked ? "bg-white text-zinc-900 shadow" : "text-zinc-300 hover:bg-white/10 hover:text-white",
              )}
            >
              <m.icon className="size-4 shrink-0" />
              <span className="truncate">{m.label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            {p.micId === "none" ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />} Microphone
          </span>
          <select
            value={p.micId}
            onChange={(e) => p.onMicId(e.target.value)}
            className="h-9 w-full min-w-0 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50"
          >
            <option value="default">Default microphone</option>
            {p.mics.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
            <option value="none">No microphone</option>
          </select>
          {p.micId !== "none" && <MicMeter stream={p.mic} />}
        </label>

        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <Volume2 className="size-3.5" /> Computer audio
          </span>
          <label
            className={cn(
              "flex h-9 items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-sm text-zinc-200",
              (!p.sysAudioOk || p.mode === "camera") && "opacity-50",
            )}
            title={p.sysAudioOk ? "Include sound from the tab or screen you share" : "Not supported in this browser"}
          >
            <span className="truncate">{p.sysAudioOk ? "Include tab / system audio" : "Not supported in this browser"}</span>
            <input
              type="checkbox"
              role="switch"
              checked={p.systemAudio && p.sysAudioOk}
              disabled={!p.sysAudioOk || p.mode === "camera"}
              onChange={(e) => p.onSystemAudio(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="relative h-5 w-9 shrink-0 rounded-full bg-white/15 transition-colors peer-checked:bg-sky-500 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400/60 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
            />
          </label>
          {p.hasScreen && p.sysAudioOk && p.mode !== "camera" && (
            <span className="text-[11px] text-zinc-500">Changing this applies the next time you choose what to share.</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {p.mode !== "camera" && p.hasScreen && (
          <button
            type="button"
            onClick={p.onChooseScreen}
            className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-300 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
          >
            <Monitor className="size-4" /> Change screen
          </button>
        )}
        <button
          type="button"
          onClick={p.onCancel}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-300 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <X className="size-4" /> Cancel
        </button>
        <button
          type="button"
          onClick={p.onStart}
          className="flex h-9 items-center gap-2 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white shadow-lg shadow-red-500/20 outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-300"
        >
          <Circle className="size-3 fill-current" />
          Start recording
        </button>
      </div>
    </div>
  );
}
