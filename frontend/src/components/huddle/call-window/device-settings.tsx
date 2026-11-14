"use client";

import { Room, RoomEvent } from "livekit-client";
import { Camera, ChevronDown, Mic, Speaker } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { callSounds } from "@/components/calls/tones";

import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { preJoinSkip } from "../pre-join";

export type Kind = "audioinput" | "videoinput" | "audiooutput";
type DeviceLists = Record<Kind, MediaDeviceInfo[]>;

const ALL_KINDS: readonly Kind[] = ["audioinput", "videoinput", "audiooutput"];
const EMPTY: DeviceLists = { audioinput: [], videoinput: [], audiooutput: [] };

export function speakerSelectionSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/**
 * Microphone / camera / speaker pickers. Lists devices when mounted and whenever devices change
 * (plug/unplug), and switches with `room.switchActiveDevice`. Mount it only while visible.
 */
export function DeviceSettingsBody({
  room,
  kinds = ALL_KINDS,
}: {
  room: Room | null;
  /** Which pickers to show (all by default). */
  kinds?: readonly Kind[];
}) {
  const [devices, setDevices] = useState<DeviceLists>(EMPTY);
  const [active, setActive] = useState<Partial<Record<Kind, string>>>({});
  const [loaded, setLoaded] = useState(false);
  const speaker = speakerSelectionSupported();

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [a, v, o] = await Promise.all([
          Room.getLocalDevices("audioinput", false),
          Room.getLocalDevices("videoinput", false),
          speaker ? Room.getLocalDevices("audiooutput", false) : Promise.resolve([] as MediaDeviceInfo[]),
        ]);
        if (!live) return;
        setDevices({ audioinput: a, videoinput: v, audiooutput: o });
        setActive({
          audioinput: room?.getActiveDevice("audioinput"),
          videoinput: room?.getActiveDevice("videoinput"),
          audiooutput: room?.getActiveDevice("audiooutput"),
        });
      } catch {
        // enumerateDevices unavailable (insecure context); leave the lists empty.
      } finally {
        if (live) setLoaded(true);
      }
    };
    void load();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", load);
    room?.on(RoomEvent.ActiveDeviceChanged, load);
    return () => {
      live = false;
      md?.removeEventListener?.("devicechange", load);
      room?.off(RoomEvent.ActiveDeviceChanged, load);
    };
  }, [room, speaker]);

  async function pick(kind: Kind, deviceId: string) {
    setActive((a) => ({ ...a, [kind]: deviceId }));
    if (!room) return;
    try {
      const ok = await room.switchActiveDevice(kind, deviceId);
      if (ok === false) throw new Error("switch failed");
    } catch {
      toast.error(
        kind === "audiooutput"
          ? "Couldn't switch speakers."
          : `Couldn't switch to that ${kind === "audioinput" ? "microphone" : "camera"}.`,
      );
      setActive((a) => ({ ...a, [kind]: room.getActiveDevice(kind) }));
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={!loaded}>
      {kinds.includes("audioinput") && (
        <DeviceSelect label="Microphone" icon={Mic} kind="audioinput" list={devices.audioinput} value={active.audioinput} onPick={pick} />
      )}
      {kinds.includes("videoinput") && (
        <DeviceSelect label="Camera" icon={Camera} kind="videoinput" list={devices.videoinput} value={active.videoinput} onPick={pick} />
      )}
      {kinds.includes("audiooutput") &&
        (speaker ? (
          <DeviceSelect label="Speaker" icon={Speaker} kind="audiooutput" list={devices.audiooutput} value={active.audiooutput} onPick={pick} />
        ) : (
          <p className="text-xs text-muted-foreground">Speaker selection isn&apos;t supported in this browser; audio plays through your system output.</p>
        ))}
    </div>
  );
}

export function DeviceSelect({
  label,
  icon: Icon,
  kind,
  list,
  value,
  onPick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  kind: Kind;
  list: MediaDeviceInfo[];
  value: string | undefined;
  onPick: (kind: Kind, id: string) => void;
}) {
  const id = useId();
  const noun = kind === "audioinput" ? "Microphone" : kind === "videoinput" ? "Camera" : "Speaker";
  const options = list.filter((d) => d.deviceId);
  const current = value && options.some((d) => d.deviceId === value) ? value : (options[0]?.deviceId ?? "");
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={current}
          disabled={!options.length}
          onChange={(e) => onPick(kind, e.target.value)}
          className={cn(
            "h-9 w-full appearance-none truncate rounded-lg border border-input bg-background pr-8 pl-2.5 text-sm outline-none",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60",
          )}
        >
          {!options.length && <option value="">No {noun.toLowerCase()} found</option>}
          {options.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `${noun} ${i + 1}`}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
    </div>
  );
}

/** Per-device call preferences: join/leave sounds and the pre-join camera check. */
export function CallPrefsToggles() {
  const sounds = useSyncExternalStore(callSounds.subscribe, callSounds.getSnapshot, callSounds.getServerSnapshot);
  const skipCheck = useSyncExternalStore(preJoinSkip.subscribe, preJoinSkip.getSnapshot, preJoinSkip.getServerSnapshot);
  return (
    <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
      <PrefSwitch
        label="Call sounds"
        hint="A soft knock when someone joins, a tone when they leave"
        checked={sounds}
        onChange={(on) => callSounds.set(on)}
      />
      <PrefSwitch
        label="Camera check before video"
        hint="Preview your camera and mic before joining"
        checked={!skipCheck}
        onChange={(on) => preJoinSkip.set(!on)}
      />
    </div>
  );
}

function PrefSwitch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-3 rounded-lg py-1.5">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
          checked ? "bg-emerald-500" : "bg-white/15",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
