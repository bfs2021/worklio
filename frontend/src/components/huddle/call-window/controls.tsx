"use client";

import type { Room } from "livekit-client";
import {
  AppWindow,
  Captions,
  CaptionsOff,
  ChevronUp,
  Ellipsis,
  Hand,
  Mic,
  MicOff,
  MonitorUp,
  PanelRight,
  PenLine,
  PhoneOff,
  Radio,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  SmilePlus,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openEffectsPanel } from "@/components/effects/panel-state";
import { useEffectsPrefs } from "@/components/effects/store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { useHuddles } from "../huddle-provider";
import { canScreenShare, isUserCancelled, mediaErrorMessage } from "../room-store";
import type { HuddleRoomSnapshot } from "../types";
import { CallPrefsToggles, DeviceSettingsBody } from "./device-settings";
import { MicLevel } from "./mic-level";
import type { StageMode } from "./room-data";
import { CALL_REACTIONS, getCallSignals } from "./signals";
import { CALL_THEME_VARS, CALL_POPOVER_CLASS } from "./theme";

export type Tone = "stage" | "surface";
type ButtonState = "default" | "off" | "on" | "warn" | "live";

const ROUND =
  "relative inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-[background-color,color,box-shadow,transform] duration-150 active:scale-95 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100";

function toneClass(tone: Tone, state: ButtonState) {
  if (tone === "stage") {
    return {
      default:
        "bg-white/[0.08] text-white ring-1 ring-white/10 hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/60",
      off: "bg-red-500/90 text-white ring-1 ring-red-400/40 hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-200/70",
      on: "bg-white text-zinc-900 hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-white/60",
      warn: "bg-amber-400 text-amber-950 hover:bg-amber-300 focus-visible:ring-2 focus-visible:ring-amber-200/70",
      live: "bg-emerald-500 text-emerald-950 hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-200/70",
    }[state];
  }
  return {
    default: "bg-muted text-foreground hover:bg-foreground/10 focus-visible:ring-3 focus-visible:ring-ring/50",
    off: "bg-red-500/15 text-red-600 hover:bg-red-500/25 focus-visible:ring-3 focus-visible:ring-ring/50 dark:text-red-400",
    on: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-3 focus-visible:ring-ring/50",
    warn: "bg-amber-400 text-amber-950 hover:bg-amber-300 focus-visible:ring-3 focus-visible:ring-ring/50",
    live: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-3 focus-visible:ring-ring/50",
  }[state];
}

type RoundProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone: Tone;
  state?: ButtonState;
  size?: "xs" | "sm" | "md" | "lg";
  label: string;
  ref?: React.Ref<HTMLButtonElement>;
};

/** Round control button. Forwards ref/props so it can be a Popover/Menu/Tooltip trigger's `render`. */
export function RoundButton({ tone, state = "default", size = "md", label, className, children, ref, ...rest }: RoundProps) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      {...rest}
      className={cn(
        ROUND,
        size === "xs"
          ? "size-7 [&_svg]:size-3.5"
          : size === "sm"
            ? "size-9 [&_svg]:size-4"
            : size === "md"
              ? "size-11 [&_svg]:size-5"
              : "size-12 [&_svg]:size-5",
        toneClass(tone, state),
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Tooltip with an optional keyboard shortcut chip. `trigger` must accept props + ref. */
export function Tip({
  label,
  keys,
  side = "top",
  trigger,
  children,
}: {
  label: string;
  keys?: string;
  side?: "top" | "bottom" | "left" | "right";
  trigger: React.ReactElement;
  children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={8} className="bg-zinc-800 text-zinc-50 ring-1 ring-white/10">
        <span>{label}</span>
        {keys && (
          <kbd className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/15 bg-white/10 px-1 font-sans text-[10.5px] font-semibold text-white/85">
            {keys}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Emoji reactions popover. Sends over LiveKit data (topic "reactions"). */
export function ReactionButton({ room, tone, size = "md" }: { room: Room | null; tone: Tone; size?: "xs" | "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip
        label="Send a reaction"
        trigger={
          <PopoverTrigger
            render={<RoundButton tone={tone} size={size} label="Send a reaction" disabled={!room} aria-haspopup="dialog" />}
          />
        }
      >
        <SmilePlus aria-hidden />
      </Tip>
      <PopoverContent
        side="top"
        sideOffset={10}
        className={cn("w-auto rounded-full p-1.5", tone === "stage" && CALL_POPOVER_CLASS)}
        style={tone === "stage" ? CALL_THEME_VARS : undefined}
      >
        <div role="group" aria-label="Reactions" className="flex items-center gap-0.5">
          {CALL_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`React ${e}`}
              onClick={() => room && getCallSignals(room).react(e)}
              className="flex size-10 items-center justify-center rounded-full text-2xl outline-none transition-transform duration-150 hover:scale-125 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 motion-reduce:hover:scale-100"
            >
              <span aria-hidden>{e}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function HandButton({
  room,
  raised,
  tone,
  size = "md",
}: {
  room: Room | null;
  raised: boolean;
  tone: Tone;
  size?: "xs" | "sm" | "md";
}) {
  const label = raised ? "Lower hand" : "Raise hand";
  return (
    <Tip
      label={label}
      keys={tone === "stage" ? "H" : undefined}
      trigger={
        <RoundButton
          tone={tone}
          size={size}
          state={raised ? "warn" : "default"}
          label={label}
          aria-pressed={raised}
          aria-keyshortcuts={tone === "stage" ? "H" : undefined}
          disabled={!room}
          onClick={() => room && getCallSignals(room).setHand(!raised)}
        />
      }
    >
      <Hand aria-hidden className={cn(raised && "animate-in zoom-in-75 duration-200")} />
    </Tip>
  );
}

/** Mic toggle with a live input-level bar. */
export function MicButton({
  snap,
  room,
  tone,
  size = "md",
  disabled,
  className,
}: {
  snap: HuddleRoomSnapshot;
  room: Room | null;
  tone: Tone;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  className?: string;
}) {
  const { toggleMic } = useHuddles();
  const label = snap.micEnabled ? "Mute" : "Unmute";
  return (
    <Tip
      label={label}
      keys={tone === "stage" ? "M" : undefined}
      trigger={
        <RoundButton
          tone={tone}
          size={size}
          state={snap.micEnabled ? "default" : "off"}
          label={snap.micEnabled ? "Mute microphone" : "Unmute microphone"}
          aria-pressed={snap.micEnabled}
          aria-keyshortcuts="M Control+D Meta+D"
          disabled={disabled}
          onClick={() => void toggleMic()}
          className={className}
        />
      }
    >
      {snap.micEnabled ? <Mic aria-hidden /> : <MicOff aria-hidden />}
      <MicLevel
        room={room}
        enabled={snap.micEnabled && !disabled}
        className={size === "md" ? undefined : "inset-x-2 bottom-1"}
      />
    </Tip>
  );
}

/** A main control with a small "devices / options" chevron attached on its shoulder. */
function Split({ main, chevron }: { main: React.ReactNode; chevron: React.ReactNode }) {
  return (
    <span className="relative inline-flex">
      {main}
      <span className="absolute -top-1 -right-1 z-10">{chevron}</span>
    </span>
  );
}

function ChevronTrigger({ label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label={label}
      {...rest}
      className="flex size-5 items-center justify-center rounded-full bg-zinc-800 text-white/80 ring-2 ring-zinc-950 outline-none transition hover:bg-zinc-700 hover:text-white focus-visible:ring-white/70 [&_svg]:size-3"
    >
      <ChevronUp aria-hidden />
    </button>
  );
}

function DevicePopover({
  room,
  kinds,
  title,
}: {
  room: Room | null;
  kinds: ("audioinput" | "videoinput" | "audiooutput")[];
  title: string;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<ChevronTrigger label={`${title} settings`} aria-haspopup="dialog" />} />
      <PopoverContent side="top" sideOffset={10} className={cn("w-80", CALL_POPOVER_CLASS)} style={CALL_THEME_VARS}>
        <p className="text-sm font-semibold">{title}</p>
        <DeviceSettingsBody room={room} kinds={kinds} />
        {kinds.includes("videoinput") && (
          <PopoverPrimitive.Close
            onClick={openEffectsPanel}
            className="flex h-9 items-center gap-2 rounded-lg bg-white/[0.06] px-2.5 text-sm font-medium text-white outline-none ring-1 ring-white/10 transition hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <Sparkles className="size-4 text-fuchsia-300" aria-hidden />
            <span className="flex-1 text-left">Backgrounds &amp; effects</span>
          </PopoverPrimitive.Close>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** "✨ Effects": opens the camera Effects panel. Shows a dot while an effect is on. */
export function EffectsButton({ tone, size = "md", className }: { tone: Tone; size?: "xs" | "sm" | "md"; className?: string }) {
  const { effect } = useEffectsPrefs();
  const active = effect !== "none";
  const label = active ? "Backgrounds & effects (on)" : "Backgrounds & effects";
  return (
    <Tip
      label="Backgrounds & effects"
      trigger={<RoundButton tone={tone} size={size} label={label} aria-haspopup="dialog" onClick={openEffectsPanel} className={className} />}
    >
      <Sparkles aria-hidden />
      {active && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-2 rounded-full bg-fuchsia-400 ring-2 ring-zinc-950 animate-in zoom-in-50 duration-200 motion-reduce:animate-none"
        />
      )}
    </Tip>
  );
}

/** Start (optionally with tab/system audio) or stop sharing my screen. */
export function useScreenShare() {
  const { room, toggleScreenShare } = useHuddles();
  const supported = canScreenShare();
  async function start(audio: boolean) {
    const lp = room?.localParticipant;
    if (!lp) return;
    if (!supported) {
      toast.error("Screen sharing isn't supported on this device.");
      return;
    }
    try {
      await lp.setScreenShareEnabled(true, {
        audio,
        systemAudio: audio ? "include" : "exclude",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        contentHint: "detail",
      });
    } catch (err) {
      if (!isUserCancelled(err)) toast.error(mediaErrorMessage(err, "screen"));
    }
  }
  return { supported, start, toggle: toggleScreenShare };
}

/** The clearly labeled "Share screen" control with its options menu. */
function ShareControl({ snap, disabled, wide }: { snap: HuddleRoomSnapshot; disabled: boolean; wide: boolean }) {
  const { supported, start, toggle } = useScreenShare();
  const someoneElse = snap.participants.find((p) => !p.isLocal && p.screenTrack);
  if (!supported) return null;

  if (snap.screenShareEnabled) {
    return (
      <Tip
        label="Stop sharing your screen"
        keys="S"
        trigger={
          <button
            type="button"
            onClick={() => void toggle()}
            aria-label="Stop sharing screen"
            aria-keyshortcuts="S"
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 outline-none transition hover:bg-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-200/70 active:scale-95 motion-reduce:active:scale-100 [&_svg]:size-5",
              !wide && "w-11 justify-center px-0",
            )}
          />
        }
      >
        <ScreenShareOff aria-hidden />
        {wide && <span>Stop sharing</span>}
      </Tip>
    );
  }

  return (
    <DropdownMenu>
      <Tip
        label={someoneElse ? "Share your screen (takes over presenting)" : "Share your screen"}
        keys="S"
        trigger={
          <DropdownMenuTrigger
            disabled={disabled}
            render={
              <button
                type="button"
                aria-label="Share screen"
                aria-keyshortcuts="S"
                className={cn(
                  "inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-semibold text-white ring-1 ring-white/10 outline-none transition hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/60 active:scale-95 disabled:pointer-events-none disabled:opacity-40 data-popup-open:bg-white/15 motion-reduce:active:scale-100 [&_svg]:size-5",
                  !wide && "w-11 justify-center px-0",
                )}
              />
            }
          />
        }
      >
        <MonitorUp aria-hidden />
        {wide && <span>Share screen</span>}
      </Tip>
      <DropdownMenuContent side="top" align="center" sideOffset={10} className={cn("w-60 p-1.5", CALL_POPOVER_CLASS)} style={CALL_THEME_VARS}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Present to everyone</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void start(false)} className="gap-2.5 py-2">
            <ScreenShare className="size-4" aria-hidden />
            <span className="flex-1">Share screen</span>
            <kbd className="text-[10.5px] text-white/50">S</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void start(true)} className="gap-2.5 py-2">
            <Volume2 className="size-4" aria-hidden />
            <span className="flex-1">Share with audio</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="flex items-start gap-2 px-1.5 py-1 text-[11.5px] leading-snug text-white/55">
          <AppWindow className="mt-px size-3.5 shrink-0" aria-hidden />
          Pick a window, tab or your whole screen. Anyone can annotate on top of it.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Opens/closes the side panel (People · Chat · Notes), with the chat unread count. */
export function PanelButton({ open, unread, onClick, peopleCount }: { open: boolean; unread: number; onClick: () => void; peopleCount: number }) {
  const label = open ? "Hide people, chat and notes" : "Show people, chat and notes";
  return (
    <Tip
      label={label}
      keys="C"
      trigger={
        <button
          type="button"
          onClick={onClick}
          aria-pressed={open}
          aria-label={unread ? `${label}. ${unread} unread chat ${unread === 1 ? "message" : "messages"}` : label}
          className={cn(
            "relative inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold outline-none ring-1 transition focus-visible:ring-2 focus-visible:ring-white/60 active:scale-95 motion-reduce:active:scale-100 [&_svg]:size-[18px]",
            open ? "bg-white text-zinc-900 ring-white" : "bg-white/[0.08] text-white ring-white/10 hover:bg-white/15",
          )}
        />
      }
    >
      <PanelRight aria-hidden />
      <span className="tabular-nums">{peopleCount}</span>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-zinc-950 animate-in zoom-in-50 duration-200">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Tip>
  );
}

export function LeaveButton({ compact }: { compact?: boolean }) {
  const { leave } = useHuddles();
  return (
    <Tip
      label="Leave call"
      trigger={
        <button
          type="button"
          onClick={leave}
          aria-label="Leave call"
          className={cn(
            "inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-red-600 text-sm font-semibold text-white shadow-[0_10px_30px_-10px_rgb(220_38_38/0.8)] outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-200/70 active:scale-95 motion-reduce:active:scale-100 [&_svg]:size-5",
            compact ? "w-12 justify-center" : "px-4",
          )}
        />
      }
    >
      <PhoneOff aria-hidden />
      {!compact && <span>Leave</span>}
    </Tip>
  );
}

/** "CC": live captions on/off. Off-looking but still clickable when the browser can't transcribe. */
export function CaptionsButton({
  on,
  supported,
  onClick,
  size = "md",
}: {
  on: boolean;
  supported: boolean;
  onClick: () => void;
  size?: "xs" | "sm" | "md";
}) {
  const label = on ? "Turn off live captions" : "Turn on live captions";
  return (
    <Tip
      label={supported ? label : `${label} (others' only: yours need Chrome or Edge)`}
      trigger={<RoundButton tone="stage" size={size} state={on ? "on" : "default"} label={label} aria-pressed={on} onClick={onClick} />}
    >
      {on ? <Captions aria-hidden /> : <CaptionsOff aria-hidden />}
    </Tip>
  );
}

export type StageOption = { mode: StageMode; label: string; icon: React.ComponentType<{ className?: string }> };

/**
 * Bottom control bar of the call window. Everything fits at 360px: on phones the less-used
 * actions collapse into a "More" popover.
 */
export function CallControls({
  snap,
  room,
  handRaised,
  disabled,
  isDesktop,
  wide,
  annotating,
  onAnnotate,
  panelOpen,
  onPanel,
  unread,
  stageOptions,
  stage,
  onStage,
  onPresent,
  captions,
}: {
  snap: HuddleRoomSnapshot;
  room: Room | null;
  handRaised: boolean;
  disabled: boolean;
  isDesktop: boolean;
  /** Room for text labels (≥ lg). */
  wide: boolean;
  annotating: boolean;
  onAnnotate: (on: boolean) => void;
  panelOpen: boolean;
  onPanel: () => void;
  unread: number;
  stageOptions: StageOption[];
  stage: StageMode;
  onStage: (m: StageMode) => void;
  /** "Bring everyone" to my current stage (phones show it in the More menu). */
  onPresent?: () => void;
  /** Live captions (CC) toggle; omitted when the call can't be captioned (no call record, or it ended). */
  captions?: { on: boolean; supported: boolean; onToggle: () => void };
}) {
  const { toggleCamera } = useHuddles();
  const screenShared = snap.participants.some((p) => p.screenTrack);
  const tone: Tone = "stage";

  const camera = (
    <Split
      main={
        <Tip
          label={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
          keys="V"
          trigger={
            <RoundButton
              tone={tone}
              state={snap.cameraEnabled ? "default" : "off"}
              label={snap.cameraEnabled ? "Turn off camera" : "Turn on camera"}
              aria-pressed={snap.cameraEnabled}
              aria-keyshortcuts="V"
              disabled={disabled}
              onClick={() => void toggleCamera()}
            />
          }
        >
          {snap.cameraEnabled ? <Video aria-hidden /> : <VideoOff aria-hidden />}
        </Tip>
      }
      chevron={<DevicePopover room={room} kinds={["videoinput"]} title="Camera" />}
    />
  );

  const mic = (
    <Split
      main={<MicButton snap={snap} room={room} tone={tone} disabled={disabled} />}
      chevron={<DevicePopover room={room} kinds={["audioinput", "audiooutput"]} title="Microphone & speaker" />}
    />
  );

  const annotate = screenShared && (
    <Tip
      label={annotating ? "Stop annotating" : "Annotate the shared screen"}
      trigger={
        <RoundButton
          tone={tone}
          state={annotating ? "live" : "default"}
          label={annotating ? "Stop annotating" : "Annotate the shared screen"}
          aria-pressed={annotating}
          onClick={() => {
            if (stage !== "screen") onStage("screen");
            onAnnotate(!annotating);
          }}
        />
      }
    >
      <PenLine aria-hidden />
    </Tip>
  );

  const settings = (
    <Popover>
      <Tip
        label="Audio & video settings"
        trigger={<PopoverTrigger render={<RoundButton tone={tone} label="Audio and video settings" aria-haspopup="dialog" />} />}
      >
        <Settings2 aria-hidden />
      </Tip>
      <PopoverContent side="top" sideOffset={10} className={cn("w-80", CALL_POPOVER_CLASS)} style={CALL_THEME_VARS}>
        <p className="text-sm font-semibold">Audio &amp; video</p>
        <DeviceSettingsBody room={room} />
        <CallPrefsToggles />
        <p className="border-t border-white/10 pt-2 text-[11.5px] text-white/50">
          Shortcuts: <Kbd>M</Kbd> mic · <Kbd>V</Kbd> camera · <Kbd>S</Kbd> share · <Kbd>H</Kbd> hand · <Kbd>C</Kbd> panel ·{" "}
          <Kbd>Esc</Kbd> close
        </p>
      </PopoverContent>
    </Popover>
  );

  if (!isDesktop) {
    return (
      <div role="toolbar" aria-label="Call controls" className="flex w-full items-center justify-center gap-1.5 min-[400px]:gap-2">
        {mic}
        {camera}
        <ShareControl snap={snap} disabled={disabled} wide={false} />
        <Popover>
          <PopoverTrigger render={<RoundButton tone={tone} label="More options" aria-haspopup="dialog" />}>
            <Ellipsis aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            sideOffset={10}
            className={cn("w-[min(20rem,calc(100vw-2rem))] gap-3", CALL_POPOVER_CLASS)}
            style={CALL_THEME_VARS}
          >
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-bold tracking-wide text-white/50 uppercase">Stage</p>
              <div className="flex flex-wrap gap-1.5">
                {stageOptions.map((o) => (
                  <MenuChip key={o.mode} icon={o.icon} active={stage === o.mode} onClick={() => onStage(o.mode)}>
                    {o.label}
                  </MenuChip>
                ))}
              </div>
              {onPresent && (
                <MenuChip icon={Radio} onClick={onPresent}>
                  Bring everyone here
                </MenuChip>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PopoverPrimitive.Close
                onClick={openEffectsPanel}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-sm font-medium text-white outline-none ring-1 ring-white/10 transition hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <Sparkles className="size-4 text-fuchsia-300" aria-hidden />
                Effects
              </PopoverPrimitive.Close>
              <MenuChip icon={Hand} active={handRaised} onClick={() => room && getCallSignals(room).setHand(!handRaised)}>
                {handRaised ? "Lower hand" : "Raise hand"}
              </MenuChip>
              {captions && (
                <MenuChip icon={captions.on ? Captions : CaptionsOff} active={captions.on} onClick={captions.onToggle}>
                  Captions
                </MenuChip>
              )}
              {screenShared && (
                <MenuChip
                  icon={PenLine}
                  active={annotating}
                  onClick={() => {
                    if (stage !== "screen") onStage("screen");
                    onAnnotate(!annotating);
                  }}
                >
                  Annotate
                </MenuChip>
              )}
            </div>
            <div role="group" aria-label="Reactions" className="flex flex-wrap items-center gap-0.5">
              {CALL_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`React ${e}`}
                  onClick={() => room && getCallSignals(room).react(e)}
                  className="flex size-9 items-center justify-center rounded-full text-xl outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <span aria-hidden>{e}</span>
                </button>
              ))}
            </div>
            <DeviceSettingsBody room={room} />
            <CallPrefsToggles />
          </PopoverContent>
        </Popover>
        <PanelButtonCompact open={panelOpen} unread={unread} onClick={onPanel} />
        <LeaveButton compact />
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label="Call controls" className="flex w-full items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2" />
      <div className="flex items-center justify-center gap-2.5">
        {mic}
        {camera}
        <EffectsButton tone={tone} />
        <ShareControl snap={snap} disabled={disabled} wide={wide} />
        {annotate}
        <ReactionButton room={room} tone={tone} />
        <HandButton room={room} raised={handRaised} tone={tone} />
        {captions && <CaptionsButton on={captions.on} supported={captions.supported} onClick={captions.onToggle} />}
        {settings}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        <PanelButton open={panelOpen} unread={unread} onClick={onPanel} peopleCount={snap.participants.length} />
        <LeaveButton compact={!wide} />
      </div>
    </div>
  );
}

function PanelButtonCompact({ open, unread, onClick }: { open: boolean; unread: number; onClick: () => void }) {
  return (
    <RoundButton
      tone="stage"
      state={open ? "on" : "default"}
      label={unread ? `People, chat and notes. ${unread} unread` : "People, chat and notes"}
      aria-pressed={open}
      onClick={onClick}
    >
      <PanelRight aria-hidden />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-zinc-950">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </RoundButton>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-white/15 bg-white/10 px-1 font-sans text-[10px] font-semibold text-white/80">
      {children}
    </kbd>
  );
}

function MenuChip({
  onClick,
  active,
  disabled,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none ring-1 transition focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40",
        active ? "bg-white text-zinc-900 ring-white" : "bg-white/[0.06] text-white ring-white/10 hover:bg-white/12",
      )}
    >
      <Icon className="size-4" />
      {children}
    </button>
  );
}
