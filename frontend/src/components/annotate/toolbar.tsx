"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Eraser,
  Highlighter,
  type LucideIcon,
  MoveUpRight,
  Pen,
  Redo2,
  Sparkles,
  Square,
  Timer,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { type AnnotateTool, SWATCHES, WIDTHS } from "./types";

const TOOLS: { id: AnnotateTool; label: string; key: string; icon: LucideIcon }[] = [
  { id: "pen", label: "Pen", key: "P", icon: Pen },
  { id: "highlighter", label: "Highlighter", key: "H", icon: Highlighter },
  { id: "arrow", label: "Arrow", key: "A", icon: MoveUpRight },
  { id: "rect", label: "Rectangle", key: "R", icon: Square },
  { id: "ellipse", label: "Ellipse", key: "O", icon: Circle },
  { id: "text", label: "Text", key: "T", icon: Type },
  { id: "laser", label: "Laser pointer", key: "L", icon: Sparkles },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
];

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type AnnotateToolbarProps = {
  tool: AnnotateTool;
  onTool: (t: AnnotateTool) => void;
  color: string;
  onColor: (c: string) => void;
  userColor: string;
  width: number;
  onWidth: (w: number) => void;
  autoFade: boolean;
  onAutoFade: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onDone: () => void;
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
};

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-white/20 bg-white/10 px-1 font-sans text-[10px] font-semibold text-current/80">{children}</kbd>
  );
}

function ToolButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            aria-keyshortcuts={shortcut}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              "flex size-8 items-center justify-center rounded-lg text-zinc-300 transition-colors outline-none",
              "hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60 disabled:pointer-events-none disabled:opacity-35",
              pressed && "bg-white/15 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]",
              className,
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="bg-zinc-900 text-zinc-100 ring-1 ring-white/10 [&>:last-child]:hidden">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-white/12" />;
}

export function AnnotateToolbar(p: AnnotateToolbarProps) {
  const mod = isMac() ? "⌘" : "Ctrl+";
  const current = TOOLS.find((t) => t.id === p.tool) ?? TOOLS[0];
  const swatches = SWATCHES.includes(p.userColor as (typeof SWATCHES)[number]) ? [...SWATCHES] : [p.userColor, ...SWATCHES];

  return (
    <TooltipProvider delay={350}>
      <div
        role="toolbar"
        aria-label="Annotation tools"
        aria-orientation="horizontal"
        className={cn(
          "pointer-events-auto absolute top-2 left-1/2 z-20 flex max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-2xl p-1",
          "border border-white/10 bg-zinc-950/85 text-white shadow-2xl shadow-black/40 backdrop-blur-xl",
          "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2",
        )}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {p.collapsed ? (
          <>
            <span className="flex items-center gap-1.5 pr-1 pl-2 text-xs font-medium text-zinc-300">
              <current.icon className="size-4" style={{ color: p.color }} aria-hidden />
              {current.label}
            </span>
            <ToolButton label="Show tools" onClick={() => p.onCollapsed(false)}>
              <ChevronDown className="size-4" />
            </ToolButton>
          </>
        ) : (
          <>
            {TOOLS.map((t) => (
              <ToolButton key={t.id} label={t.label} shortcut={t.key} pressed={p.tool === t.id} onClick={() => p.onTool(t.id)}>
                <t.icon className="size-4" />
              </ToolButton>
            ))}
            <Divider />
            <div role="radiogroup" aria-label="Color" className="flex items-center gap-0.5 px-0.5">
              {swatches.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={p.color === c}
                  aria-label={c === p.userColor ? "Your color" : `Color ${c}`}
                  title={c === p.userColor ? "Your color" : c}
                  onClick={() => p.onColor(c)}
                  className="flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  <span
                    className={cn(
                      "size-4 rounded-full ring-1 ring-white/25 transition-transform",
                      p.color === c ? "scale-110 ring-2 ring-white ring-offset-2 ring-offset-zinc-950" : "hover:scale-110",
                    )}
                    style={{ background: c }}
                  />
                </button>
              ))}
            </div>
            <Divider />
            <div role="radiogroup" aria-label="Stroke width" className="flex items-center">
              {WIDTHS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={p.width === w.value}
                  aria-label={`${w.label} stroke`}
                  title={`${w.label} stroke`}
                  onClick={() => p.onWidth(w.value)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-lg outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60",
                    p.width === w.value && "bg-white/15",
                  )}
                >
                  <span className="rounded-full bg-zinc-200" style={{ width: 3 + w.value / 1.5, height: 3 + w.value / 1.5 }} />
                </button>
              ))}
            </div>
            <Divider />
            <ToolButton label="Undo" shortcut={`${mod}Z`} disabled={!p.canUndo} onClick={p.onUndo}>
              <Undo2 className="size-4" />
            </ToolButton>
            <ToolButton label="Redo" shortcut={`${isMac() ? "⇧⌘" : "Ctrl+Shift+"}Z`} disabled={!p.canRedo} onClick={p.onRedo}>
              <Redo2 className="size-4" />
            </ToolButton>
            <ToolButton
              label={p.autoFade ? "Auto-fade on: ink disappears after a few seconds" : "Auto-fade off"}
              pressed={p.autoFade}
              onClick={() => p.onAutoFade(!p.autoFade)}
            >
              <Timer className="size-4" />
            </ToolButton>
            <ToolButton label="Clear all annotations" onClick={p.onClear} className="hover:bg-red-500/20 hover:text-red-300">
              <Trash2 className="size-4" />
            </ToolButton>
            <Divider />
            <ToolButton label="Collapse toolbar" onClick={() => p.onCollapsed(true)}>
              <ChevronUp className="size-4" />
            </ToolButton>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={p.onDone}
                aria-keyshortcuts="Escape"
                className="ml-0.5 flex h-8 items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-semibold text-zinc-900 outline-none hover:bg-zinc-200 focus-visible:ring-2 focus-visible:ring-white/60"
              />
            }
          >
            <Check className="size-3.5" aria-hidden />
            Done
          </TooltipTrigger>
          <TooltipContent side="bottom" className="bg-zinc-900 text-zinc-100 ring-1 ring-white/10 [&>:last-child]:hidden">
            Stop annotating <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
