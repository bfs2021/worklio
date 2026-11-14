/**
 * Call sounds synthesised with the Web Audio API (no audio files).
 *
 * - "ring": a warm, two-note marimba-like pattern for incoming calls.
 * - "ringback": a soft, low pulse the caller hears while invites ring.
 *
 * Both loop until stopped and stop instantly (their bus is disconnected). Browsers keep an
 * AudioContext suspended until a user gesture, so `installUnlock()` resumes it on the first
 * pointer / key press; loops wait silently until then instead of piling up notes.
 */

export type ToneName = "ring" | "ringback";

type Loop = { timer: number; bus: GainNode };

type Pattern = { period: number; play: (ctx: AudioContext, out: AudioNode, t0: number) => void };

/** One soft mallet note: sine + a quiet octave partial, fast attack, exponential decay. */
function mallet(ctx: AudioContext, out: AudioNode, freq: number, t: number, length = 0.42, level = 0.22) {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(level, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + length);
  env.connect(out);

  const partials: [number, number][] = [
    [1, 1],
    [2, 0.18],
    [3.01, 0.05],
  ];
  for (const [mult, gain] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * mult, t);
    const g = ctx.createGain();
    g.gain.value = gain;
    osc.connect(g).connect(env);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }
}

/** A gentle sustained tone with a slow attack/release. */
function pad(ctx: AudioContext, out: AudioNode, freqs: number[], t: number, length: number, level: number) {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(level, t + 0.09);
  env.gain.setValueAtTime(level, t + length - 0.15);
  env.gain.linearRampToValueAtTime(0.0001, t + length);
  env.connect(out);
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(f, t);
    osc.connect(env);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }
}

const PATTERNS: Record<ToneName, Pattern> = {
  // E5 → B5, twice, then a breath. ~2.6 s cycle.
  ring: {
    period: 2600,
    play(ctx, out, t0) {
      const lo = 659.25;
      const hi = 987.77;
      mallet(ctx, out, lo, t0);
      mallet(ctx, out, hi, t0 + 0.16);
      mallet(ctx, out, lo, t0 + 0.52);
      mallet(ctx, out, hi, t0 + 0.68, 0.7);
    },
  },
  // A soft 1.1 s pulse every 3.6 s, much quieter than the ringtone.
  ringback: {
    period: 3600,
    play(ctx, out, t0) {
      pad(ctx, out, [415.3, 440], t0, 1.1, 0.035);
    },
  },
};

class ToneEngine {
  private ctx: AudioContext | null = null;
  private loops = new Map<ToneName, Loop>();

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** Resume the context (call from a user gesture). */
  unlock() {
    const ctx = this.context();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  get unlocked() {
    return this.ctx?.state === "running";
  }

  isPlaying(name: ToneName) {
    return this.loops.has(name);
  }

  start(name: ToneName) {
    if (this.loops.has(name)) return;
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(ctx.destination);
    const pattern = PATTERNS[name];

    let lastPlayed = 0;
    const tick = () => {
      if (ctx.state !== "running") return; // wait for a gesture rather than queueing notes
      const now = performance.now();
      if (now - lastPlayed < pattern.period - 50) return;
      lastPlayed = now;
      pattern.play(ctx, bus, ctx.currentTime + 0.03);
    };
    tick();
    // Poll a little faster than the period so the first ring after unlocking isn't delayed much.
    const timer = window.setInterval(tick, 250);
    this.loops.set(name, { timer, bus });
  }

  stop(name: ToneName) {
    const loop = this.loops.get(name);
    if (!loop) return;
    this.loops.delete(name);
    window.clearInterval(loop.timer);
    try {
      loop.bus.gain.cancelScheduledValues(0);
      loop.bus.gain.value = 0;
      loop.bus.disconnect();
    } catch {
      // already disconnected
    }
  }

  stopAll() {
    for (const name of [...this.loops.keys()]) this.stop(name);
  }

  /**
   * Plays a one-shot cue. Silently skipped when audio isn't unlocked yet (no user gesture) so
   * cues never pile up and burst out later.
   */
  once(play: (ctx: AudioContext, out: AudioNode, t0: number) => void, level = 1) {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state !== "running") {
      void ctx.resume().catch(() => {});
      return;
    }
    try {
      const bus = ctx.createGain();
      bus.gain.value = level;
      bus.connect(ctx.destination);
      play(ctx, bus, ctx.currentTime + 0.02);
      window.setTimeout(() => {
        try {
          bus.disconnect();
        } catch {
          // already gone
        }
      }, 1500);
    } catch {
      // audio graph errors are never worth surfacing
    }
  }
}

export const tones = new ToneEngine();

/** Resume audio on the first pointer / key press (and again if the browser re-suspends it). */
export function installUnlock(): () => void {
  const onGesture = () => {
    tones.unlock();
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onGesture, opts);
  window.addEventListener("keydown", onGesture, opts);
  window.addEventListener("touchend", onGesture, opts);
  return () => {
    window.removeEventListener("pointerdown", onGesture, opts);
    window.removeEventListener("keydown", onGesture, opts);
    window.removeEventListener("touchend", onGesture, opts);
  };
}

// --- "Mute call sounds" preference (per device) ---
const MUTE_KEY = "worklio.calls.muteSounds";
const muteListeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export const callSoundMute = {
  subscribe(fn: () => void) {
    muteListeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === MUTE_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      muteListeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  },
  getSnapshot: readMuted,
  getServerSnapshot: () => false,
  set(muted: boolean) {
    try {
      if (muted) localStorage.setItem(MUTE_KEY, "1");
      else localStorage.removeItem(MUTE_KEY);
    } catch {
      // private mode: the toggle just won't stick
    }
    muteListeners.forEach((fn) => fn());
  },
};

// --- "Call sounds" preference: join / leave cues inside a call (per device, on by default) ---
const CALL_SOUNDS_KEY = "worklio.callSounds";
const callSoundsListeners = new Set<() => void>();

function readCallSounds(): boolean {
  try {
    return localStorage.getItem(CALL_SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
}

export const callSounds = {
  subscribe(fn: () => void) {
    callSoundsListeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === CALL_SOUNDS_KEY) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      callSoundsListeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  },
  getSnapshot: readCallSounds,
  getServerSnapshot: () => true,
  set(on: boolean) {
    try {
      localStorage.setItem(CALL_SOUNDS_KEY, on ? "1" : "0");
    } catch {
      // private mode: the toggle just won't stick
    }
    callSoundsListeners.forEach((fn) => fn());
  },
};

/** "Someone started a huddle": a soft, rising two-note chime (~0.6 s, quieter than the ringtone). */
export function playHuddleChime() {
  tones.once((ctx, out, t) => {
    mallet(ctx, out, 783.99, t, 0.38, 0.12); // G5
    mallet(ctx, out, 1046.5, t + 0.13, 0.5, 0.1); // C6
  });
}

/** "Someone joined my call": two quick, muted wooden taps rising a fourth (< 300 ms). */
export function playJoinKnock() {
  if (!callSounds.getSnapshot()) return;
  tones.once((ctx, out, t) => {
    mallet(ctx, out, 587.33, t, 0.14, 0.09); // D5
    mallet(ctx, out, 783.99, t + 0.09, 0.2, 0.08); // G5
  });
}

/** "Someone left my call": a gentle falling pair (< 350 ms). */
export function playLeaveTone() {
  if (!callSounds.getSnapshot()) return;
  tones.once((ctx, out, t) => {
    mallet(ctx, out, 659.25, t, 0.16, 0.07); // E5
    mallet(ctx, out, 493.88, t + 0.1, 0.24, 0.06); // B4
  });
}
