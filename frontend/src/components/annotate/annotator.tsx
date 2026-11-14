"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { hitTest, isAnimating, isExpired, renderAnnotations, TEXT_FONT_FAMILY, textFontPx } from "./render";
import { AnnotateToolbar } from "./toolbar";
import { type AnnotateTool, type AnnotateUser, type AnnotationOp, LASER_MS, newOpId, unitFor, WIDTHS } from "./types";

export type AnnotatorProps = {
  /** When true the overlay captures the pointer and shows the toolbar. Remote ops render either way. */
  active: boolean;
  onActiveChange?: (active: boolean) => void;
  user: AnnotateUser;
  /** Called for every local op (including progressive re-sends of an in-progress stroke, same id). */
  send?: (op: AnnotationOp) => void;
  /** Feed remote ops in; returns an unsubscribe function. */
  subscribe?: (fn: (op: AnnotationOp) => void) => () => void;
  className?: string;
  showToolbar?: boolean;
  autoFadeDefault?: boolean;
  /** Optional lookup for remote drawers' name tags (falls back to "Someone"). */
  resolveUser?: (userId: string) => { name: string; color?: string } | undefined;
};

type Box = { w: number; h: number; dpr: number };
type TextDraft = { id: string; x: number; y: number; px: number; value: string };
type Cursor = { x: number; y: number; at: number; color: string };

const SEND_INTERVAL_MS = 40;
const TAG_MS = 1600;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Live annotation overlay. Fills its (position: relative) parent with a canvas, renders every op
 * (own + remote) and, when `active`, lets the user draw with a floating toolbar.
 */
export function Annotator({
  active,
  onActiveChange,
  user,
  send,
  subscribe,
  className,
  showToolbar = true,
  autoFadeDefault = false,
  resolveUser,
}: AnnotatorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Op log (upserts by id keep their original position).
  const opsRef = useRef<AnnotationOp[]>([]);
  const indexRef = useRef<Map<string, number>>(new Map());
  const cursorsRef = useRef<Map<string, Cursor>>(new Map());
  const boxRef = useRef<Box>({ w: 0, h: 0, dpr: 1 });
  const dirtyRef = useRef(true);

  // Local drawing state.
  const currentRef = useRef<AnnotationOp | null>(null);
  const pendingSendRef = useRef(false);
  const lastSendRef = useRef(0);
  const erasingRef = useRef<string[] | null>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<string[][]>([]);
  const redoStackRef = useRef<AnnotationOp[][]>([]);

  // Latest props for long-lived callbacks.
  const sendRef = useRef(send);
  const resolveRef = useRef(resolveUser);
  useEffect(() => {
    sendRef.current = send;
    resolveRef.current = resolveUser;
  }, [send, resolveUser]);

  const [tool, setTool] = useState<AnnotateTool>("pen");
  const [color, setColor] = useState(user.color);
  const [width, setWidth] = useState<number>(WIDTHS[1].value);
  const [autoFade, setAutoFade] = useState(autoFadeDefault);
  const [collapsed, setCollapsed] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const [draft, setDraft] = useState<TextDraft | null>(null);

  const syncHistory = useCallback(() => {
    setHistory({ undo: undoStackRef.current.length, redo: redoStackRef.current.length });
  }, []);

  /** Insert or replace an op in the local log. */
  const upsert = useCallback((op: AnnotationOp) => {
    const idx = indexRef.current.get(op.id);
    if (idx == null) {
      indexRef.current.set(op.id, opsRef.current.length);
      opsRef.current.push(op);
    } else {
      opsRef.current[idx] = op;
    }
    dirtyRef.current = true;
  }, []);

  const emit = useCallback(
    (op: AnnotationOp) => {
      upsert(op);
      sendRef.current?.(op);
    },
    [upsert],
  );

  // --- Remote ops ---
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((raw) => {
      if (!raw || typeof raw.id !== "string" || typeof raw.kind !== "string") return;
      const now = Date.now();
      // Re-base the sender's clock onto ours so fades and laser trails age correctly.
      const skew = now - (Number(raw.t) || now);
      const op: AnnotationOp =
        raw.kind === "laser"
          ? { ...raw, t: now, points: (raw.points ?? []).map((p) => [p[0], p[1], (p[2] ?? raw.t) + skew]) }
          : { ...raw, t: now };
      upsert(op);
      if (raw.userId !== user.id) {
        const last = op.points?.[op.points.length - 1] ?? op.to ?? op.from;
        if (last && (op.kind === "stroke" || op.kind === "shape" || op.kind === "laser" || op.kind === "text")) {
          cursorsRef.current.set(op.userId, { x: last[0], y: last[1], at: now, color: op.color });
        }
      }
    });
  }, [subscribe, upsert, user.id]);

  // --- Sizing ---
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      boxRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      dirtyRef.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Mirror of `tool` for the render loop (refs may only be written outside render).
  const currentToolRef = useRef<AnnotateTool>(tool);
  useEffect(() => {
    currentToolRef.current = tool;
    dirtyRef.current = true;
  }, [tool]);

  // --- Render loop ---
  useEffect(() => {
    let raf = 0;
    let lastPrune = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = Date.now();
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      // Progressive send of the in-progress op (throttled).
      if (pendingSendRef.current && currentRef.current && now - lastSendRef.current >= SEND_INTERVAL_MS) {
        pendingSendRef.current = false;
        lastSendRef.current = now;
        sendRef.current?.({ ...currentRef.current, t: now });
      }

      // Drop ops nobody can see any more (faded ink, expired laser trails).
      if (now - lastPrune > 2000) {
        lastPrune = now;
        const ops = opsRef.current;
        if (ops.some((op) => op !== currentRef.current && isExpired(op, now))) {
          opsRef.current = ops.filter((op) => op === currentRef.current || !isExpired(op, now));
          indexRef.current = new Map(opsRef.current.map((op, i) => [op.id, i]));
          dirtyRef.current = true;
        }
      }

      const cursors = cursorsRef.current;
      let tagsLive = false;
      for (const [id, c] of cursors) {
        if (now - c.at < TAG_MS) tagsLive = true;
        else cursors.delete(id);
      }
      const animating = isAnimating(opsRef.current, now);
      const showEraser = erasingRef.current != null || (hoverRef.current != null && currentToolRef.current === "eraser");
      if (!dirtyRef.current && !animating && !tagsLive && !showEraser) return;
      dirtyRef.current = animating || tagsLive;

      const { w, h, dpr } = boxRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderAnnotations(ctx, opsRef.current, w, h, now);

      // Remote drawers' name tags.
      for (const [userId, c] of cursors) {
        const life = 1 - (now - c.at) / TAG_MS;
        if (life <= 0) continue;
        const name = resolveRef.current?.(userId)?.name ?? "Someone";
        drawTag(ctx, c.x * w, c.y * h, name, c.color, Math.min(1, life * 3));
      }

      // Eraser cursor.
      const hover = hoverRef.current;
      if (showEraser && hover) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 3;
        ctx.beginPath();
        ctx.arc(hover.x * w, hover.y * h, eraserRadius(w, h), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        dirtyRef.current = true;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Leaving annotate mode abandons anything half-drawn.
  useEffect(() => {
    if (active) return;
    currentRef.current = null;
    erasingRef.current = null;
    hoverRef.current = null;
    dirtyRef.current = true;
  }, [active]);

  const pushUndo = (ids: string[]) => {
    if (!ids.length) return;
    undoStackRef.current.push(ids);
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
    syncHistory();
  };

  // --- Text ---
  const commitDraft = () => {
    // Enter and the following blur can both land here; the draft id makes it idempotent.
    if (!draft || indexRef.current.has(draft.id)) {
      setDraft(null);
      return;
    }
    const value = draft.value.replace(/\s+$/, "");
    setDraft(null);
    if (!value) return;
    const op: AnnotationOp = {
      kind: "text",
      id: draft.id,
      userId: user.id,
      color,
      width,
      fade: autoFade,
      from: [draft.x, draft.y],
      text: value.slice(0, 2000),
      t: Date.now(),
    };
    emit(op);
    pushUndo([op.id]);
  };

  useEffect(() => {
    if (draft) textRef.current?.focus({ preventScroll: true });
  }, [draft]);

  // --- Pointer input ---
  const toNorm = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = rootRef.current!.getBoundingClientRect();
    return [round(clamp01((e.clientX - rect.left) / Math.max(1, rect.width))), round(clamp01((e.clientY - rect.top) / Math.max(1, rect.height)))];
  };

  const eraseAt = (x: number, y: number) => {
    const { w, h } = boxRef.current;
    const hits = hitTest(opsRef.current, x, y, w, h, eraserRadius(w, h), Date.now());
    for (const target of hits) {
      const op: AnnotationOp = { kind: "erase", id: newOpId(), userId: user.id, color, text: target, t: Date.now() };
      emit(op);
      erasingRef.current?.push(op.id);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || e.button > 0) return;
    // Clicking away from an open text box commits it (via its blur); don't start something new.
    if (draft) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = toNorm(e);
    const now = Date.now();
    const base = { id: newOpId(), userId: user.id, color, width, fade: autoFade, t: now };
    switch (tool) {
      case "pen":
      case "highlighter":
        currentRef.current = { ...base, kind: "stroke", tool, points: [[x, y]] };
        break;
      case "arrow":
      case "rect":
      case "ellipse":
        currentRef.current = { ...base, kind: "shape", tool, from: [x, y], to: [x, y] };
        break;
      case "laser":
        currentRef.current = { ...base, kind: "laser", tool, fade: false, points: [[x, y, now]] };
        break;
      case "eraser":
        erasingRef.current = [];
        hoverRef.current = { x, y };
        eraseAt(x, y);
        return;
      case "text": {
        const { w, h } = boxRef.current;
        const px = textFontPx({ ...base, kind: "text" }, unitFor(w, h));
        setDraft({ id: newOpId(), x, y: Math.max(0, y - px / 2 / Math.max(1, h)), px, value: "" });
        return;
      }
    }
    upsert(currentRef.current!);
    pendingSendRef.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const [hx, hy] = toNorm(e);
    hoverRef.current = { x: hx, y: hy };
    if (erasingRef.current) {
      eraseAt(hx, hy);
      return;
    }
    const cur = currentRef.current;
    if (!cur) {
      if (tool === "eraser") dirtyRef.current = true;
      return;
    }
    const { w, h } = boxRef.current;
    const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const samples = events.length ? events : [e.nativeEvent];
    let next: AnnotationOp = cur;
    if (cur.kind === "stroke" || cur.kind === "laser") {
      const pts = [...(cur.points ?? [])];
      const now = Date.now();
      for (const s of samples) {
        const [x, y] = toNorm(s);
        const last = pts[pts.length - 1];
        if (last && Math.hypot((x - last[0]) * w, (y - last[1]) * h) < 0.75) continue;
        pts.push(cur.kind === "laser" ? [x, y, now] : [x, y]);
      }
      // Laser only needs the visible tail.
      const trimmed = cur.kind === "laser" ? pts.filter((p) => now - (p[2] ?? now) < LASER_MS + 100).slice(-160) : pts.slice(-4000);
      next = { ...cur, points: trimmed, t: now };
    } else if (cur.kind === "shape" && cur.from) {
      let [x, y] = toNorm(e);
      if (e.shiftKey) [x, y] = constrain(cur.tool, cur.from, [x, y], w, h);
      next = { ...cur, to: [round(clamp01(x)), round(clamp01(y))], t: Date.now() };
    }
    currentRef.current = next;
    upsert(next);
    pendingSendRef.current = true;
  };

  const finishPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (erasingRef.current) {
      pushUndo(erasingRef.current);
      erasingRef.current = null;
      return;
    }
    const cur = currentRef.current;
    if (!cur) return;
    currentRef.current = null;
    pendingSendRef.current = false;
    const final = { ...cur, t: Date.now() };
    // A click with a shape tool makes nothing useful; drop it.
    if (final.kind === "shape" && final.from && final.to) {
      const { w, h } = boxRef.current;
      if (Math.hypot((final.to[0] - final.from[0]) * w, (final.to[1] - final.from[1]) * h) < 4) {
        opsRef.current = opsRef.current.filter((op) => op.id !== final.id);
        indexRef.current = new Map(opsRef.current.map((op, i) => [op.id, i]));
        dirtyRef.current = true;
        return;
      }
    }
    emit(final);
    if (final.kind !== "laser") pushUndo([final.id]);
  };

  const onPointerLeave = () => {
    if (!erasingRef.current) hoverRef.current = null;
    dirtyRef.current = true;
  };

  // --- History ---
  const findOp = (id: string) => {
    const idx = indexRef.current.get(id);
    return idx == null ? undefined : opsRef.current[idx];
  };

  const undo = () => {
    const ids = undoStackRef.current.pop();
    if (!ids) return;
    const restored: AnnotationOp[] = [];
    for (const id of ids) {
      const target = findOp(id);
      if (target) restored.push(target);
      emit({ kind: "undo", id: newOpId(), userId: user.id, color, text: id, t: Date.now() });
    }
    if (restored.length) redoStackRef.current.push(restored);
    syncHistory();
  };

  const redo = () => {
    const group = redoStackRef.current.pop();
    if (!group) return;
    const ids: string[] = [];
    for (const op of group) {
      const copy = { ...op, id: newOpId(), t: Date.now() };
      emit(copy);
      ids.push(copy.id);
    }
    undoStackRef.current.push(ids);
    syncHistory();
  };

  const clear = () => {
    const op: AnnotationOp = { kind: "clear", id: newOpId(), userId: user.id, color, t: Date.now() };
    emit(op);
    pushUndo([op.id]);
  };

  // --- Keyboard ---
  useEffect(() => {
    if (!active) return;
    const keyTools: Record<string, AnnotateTool> = { p: "pen", h: "highlighter", a: "arrow", r: "rect", o: "ellipse", t: "text", l: "laser", e: "eraser" };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (typing) return;
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onActiveChange?.(false);
        return;
      }
      if (mod || e.altKey) return;
      const nextTool = keyTools[key];
      if (nextTool) {
        e.preventDefault();
        setTool(nextTool);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const cursor =
    tool === "text" ? "text" : tool === "eraser" ? "none" : tool === "laser" ? "crosshair" : "crosshair";

  return (
    <div
      ref={rootRef}
      className={cn("pointer-events-none absolute inset-0 z-10 overflow-hidden select-none", className)}
      data-annotating={active ? "" : undefined}
    >
      <canvas
        ref={canvasRef}
        aria-label={active ? `Annotation canvas, ${tool} tool` : undefined}
        aria-hidden={active ? undefined : true}
        role={active ? "img" : undefined}
        className={cn("absolute inset-0 size-full touch-none", active ? "pointer-events-auto" : "pointer-events-none")}
        style={active ? { cursor } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onPointerLeave={onPointerLeave}
      />

      {active && draft && (
        <textarea
          ref={textRef}
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitDraft();
            }
          }}
          aria-label="Annotation text"
          placeholder="Type…"
          rows={Math.max(1, draft.value.split("\n").length)}
          className="pointer-events-auto absolute resize-none overflow-hidden border-0 bg-black/30 p-0 leading-[1.25] outline-none ring-1 ring-white/40 placeholder:text-white/50 rounded-sm"
          style={{
            left: `${draft.x * 100}%`,
            top: `${draft.y * 100}%`,
            color,
            font: TEXT_FONT_FAMILY.replace("{size}", String(draft.px)),
            minWidth: "4ch",
            width: `${Math.max(4, ...draft.value.split("\n").map((l) => l.length + 1))}ch`,
            maxWidth: `${(1 - draft.x) * 100}%`,
          }}
        />
      )}

      {active && showToolbar && (
        <AnnotateToolbar
          tool={tool}
          onTool={setTool}
          color={color}
          onColor={setColor}
          userColor={user.color}
          width={width}
          onWidth={setWidth}
          autoFade={autoFade}
          onAutoFade={setAutoFade}
          canUndo={history.undo > 0}
          canRedo={history.redo > 0}
          onUndo={undo}
          onRedo={redo}
          onClear={clear}
          onDone={() => onActiveChange?.(false)}
          collapsed={collapsed}
          onCollapsed={setCollapsed}
        />
      )}
    </div>
  );
}

function eraserRadius(w: number, h: number) {
  return Math.max(8, 12 * unitFor(w, h));
}

/** Shift-drag: 45° arrows, squares and circles. */
function constrain(tool: string | undefined, from: [number, number], to: [number, number], w: number, h: number): [number, number] {
  const dx = (to[0] - from[0]) * w;
  const dy = (to[1] - from[1]) * h;
  if (tool === "arrow") {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [from[0] + (Math.cos(angle) * len) / w, from[1] + (Math.sin(angle) * len) / h];
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [from[0] + (Math.sign(dx) * side) / w, from[1] + (Math.sign(dy) * side) / h];
}

function drawTag(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // Pointer arrow.
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 3, y + 13);
  ctx.lineTo(x + 6.5, y + 9);
  ctx.lineTo(x + 12, y + 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Name pill.
  const label = name.length > 24 ? `${name.slice(0, 23)}…` : name;
  ctx.font = `600 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const tw = ctx.measureText(label).width;
  const px = x + 10;
  const py = y + 12;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(px, py, tw + 12, 18, 9);
  else ctx.rect(px, py, tw + 12, 18);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = readableInk(color);
  ctx.textBaseline = "middle";
  ctx.fillText(label, px + 6, py + 9.5);
  ctx.restore();
}

/** Black or white text, whichever reads better on `hex`. */
export function readableInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#18181b" : "#ffffff";
}
