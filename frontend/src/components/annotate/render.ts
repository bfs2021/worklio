/**
 * Framework-free annotation renderer. Used by <Annotator> for the on-screen overlay and by the
 * recording compositor, so what the presenter sees is exactly what lands in the recording.
 */

import { getStroke } from "perfect-freehand";

import { type AnnotationOp, FADE_HOLD_MS, FADE_OUT_MS, LASER_MS, unitFor } from "./types";

type Drawable = AnnotationOp & { kind: "stroke" | "shape" | "text" | "laser" };

/**
 * Resolve the op log into the ops that are currently visible, in paint order.
 * undo cancels its target (including an erase or clear), erase removes its target, clear removes
 * everything before it. Deterministic, so every participant converges on the same picture.
 */
export function visibleOps(ops: readonly AnnotationOp[]): Drawable[] {
  const undone = new Set<string>();
  for (const op of ops) if (op.kind === "undo" && op.text) undone.add(op.text);
  const live = new Map<string, Drawable>();
  for (const op of ops) {
    if (undone.has(op.id)) continue;
    switch (op.kind) {
      case "stroke":
      case "shape":
      case "text":
      case "laser":
        live.set(op.id, op as Drawable);
        break;
      case "erase":
        if (op.text) live.delete(op.text);
        break;
      case "clear":
        live.clear();
        break;
      default:
        break;
    }
  }
  return [...live.values()];
}

/** Opacity of an op at `now` (auto-fade). 0 = gone. */
export function opAlpha(op: AnnotationOp, now: number): number {
  if (!op.fade || op.kind === "laser") return 1;
  const age = now - op.t;
  if (age <= FADE_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - FADE_HOLD_MS) / FADE_OUT_MS);
}

/** True while something on screen is still changing with time (laser trails, fading ink). */
export function isAnimating(ops: readonly AnnotationOp[], now: number): boolean {
  for (const op of ops) {
    if (op.kind === "laser") {
      const last = op.points?.[op.points.length - 1];
      if (last && now - (last[2] ?? op.t) < LASER_MS + 50) return true;
    } else if (op.fade && now - op.t < FADE_HOLD_MS + FADE_OUT_MS + 50) {
      return true;
    }
  }
  return false;
}

/** Ops that can never be seen again (faded / expired laser) — safe to prune from memory. */
export function isExpired(op: AnnotationOp, now: number): boolean {
  if (op.kind === "laser") {
    const last = op.points?.[op.points.length - 1];
    return !last || now - (last[2] ?? op.t) > LASER_MS + 500;
  }
  return !!op.fade && now - op.t > FADE_HOLD_MS + FADE_OUT_MS + 500;
}

const pathCache = new Map<string, Path2D>();

function strokePath(op: AnnotationOp, w: number, h: number, unit: number): Path2D | null {
  const pts = op.points;
  if (!pts?.length || typeof Path2D === "undefined") return null;
  const highlighter = op.tool === "highlighter";
  const width = (op.width ?? 6) * unit * (highlighter ? 3 : 1);
  const key = `${op.id}|${pts.length}|${w}x${h}|${width.toFixed(2)}|${op.tool ?? ""}`;
  const hit = pathCache.get(key);
  if (hit) return hit;
  const outline = getStroke(
    pts.map((p) => [p[0] * w, p[1] * h]),
    highlighter
      ? { size: width, thinning: 0, smoothing: 0.6, streamline: 0.5, simulatePressure: false, last: true }
      : {
          size: width,
          thinning: 0.55,
          smoothing: 0.55,
          streamline: 0.45,
          simulatePressure: true,
          start: { taper: width * 2, cap: true },
          end: { taper: width * 2.5, cap: true },
          last: true,
        },
  );
  const path = new Path2D();
  if (outline.length < 2) {
    const [x, y] = [pts[0][0] * w, pts[0][1] * h];
    path.arc(x, y, width / 2, 0, Math.PI * 2);
  } else {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i];
      const [x1, y1] = outline[(i + 1) % outline.length];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
  }
  if (pathCache.size > 600) pathCache.clear();
  pathCache.set(key, path);
  return path;
}

export function textFontPx(op: AnnotationOp, unit: number): number {
  return Math.round((op.width ?? 6) * 4 * unit + 8);
}

export const TEXT_FONT_FAMILY = `600 {size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

function drawArrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, lw: number) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.max(10, lw * 3.2);
  const len = Math.hypot(x1 - x0, y1 - y0);
  // Stop the shaft short of the tip so the round cap doesn't poke through the head.
  const sx = x1 - Math.cos(angle) * Math.min(len, head * 0.6);
  const sy = y1 - Math.sin(angle) * Math.min(len, head * 0.6);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(sx, sy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(angle - Math.PI / 7), y1 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x1 - head * Math.cos(angle + Math.PI / 7), y1 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawLaser(ctx: CanvasRenderingContext2D, op: AnnotationOp, w: number, h: number, unit: number, now: number) {
  const pts = (op.points ?? []).filter((p) => now - (p[2] ?? op.t) < LASER_MS);
  if (!pts.length) return;
  const base = Math.max(3, 5 * unit);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = op.color;
  ctx.shadowBlur = 14 * unit + 4;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const life = 1 - (now - (b[2] ?? op.t)) / LASER_MS;
    if (life <= 0) continue;
    ctx.globalAlpha = Math.min(1, life * 1.2);
    ctx.strokeStyle = op.color;
    ctx.lineWidth = base * (0.35 + 0.65 * life);
    ctx.beginPath();
    ctx.moveTo(a[0] * w, a[1] * h);
    ctx.lineTo(b[0] * w, b[1] * h);
    ctx.stroke();
  }
  // Hot white core + head dot.
  ctx.shadowBlur = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const life = 1 - (now - (b[2] ?? op.t)) / LASER_MS;
    if (life <= 0) continue;
    ctx.globalAlpha = life * 0.85;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = base * 0.35 * life;
    ctx.beginPath();
    ctx.moveTo(a[0] * w, a[1] * h);
    ctx.lineTo(b[0] * w, b[1] * h);
    ctx.stroke();
  }
  const head = pts[pts.length - 1];
  const headLife = 1 - (now - (head[2] ?? op.t)) / LASER_MS;
  if (headLife > 0) {
    ctx.globalAlpha = Math.min(1, headLife * 1.5);
    ctx.shadowColor = op.color;
    ctx.shadowBlur = 18 * unit + 6;
    ctx.fillStyle = op.color;
    ctx.beginPath();
    ctx.arc(head[0] * w, head[1] * h, base * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(head[0] * w, head[1] * h, base * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawOne(ctx: CanvasRenderingContext2D, op: Drawable, w: number, h: number, unit: number, now: number) {
  if (op.kind === "laser") {
    drawLaser(ctx, op, w, h, unit, now);
    return;
  }
  const alpha = opAlpha(op, now);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = op.color;
  ctx.strokeStyle = op.color;
  if (op.kind === "stroke") {
    const path = strokePath(op, w, h, unit);
    if (path) {
      if (op.tool === "highlighter") ctx.globalAlpha = alpha * 0.38;
      ctx.fill(path);
    }
  } else if (op.kind === "shape" && op.from && op.to) {
    const [x0, y0] = [op.from[0] * w, op.from[1] * h];
    const [x1, y1] = [op.to[0] * w, op.to[1] * h];
    const lw = (op.width ?? 6) * unit;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (op.tool === "arrow") {
      drawArrow(ctx, x0, y0, x1, y1, lw);
    } else if (op.tool === "ellipse") {
      ctx.beginPath();
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const r = Math.min(lw * 1.5, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), r);
      else ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.stroke();
    }
  } else if (op.kind === "text" && op.from && op.text) {
    const size = textFontPx(op, unit);
    ctx.font = TEXT_FONT_FAMILY.replace("{size}", String(size));
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = Math.max(2, size / 8);
    const lines = op.text.split("\n");
    lines.forEach((line, i) => ctx.fillText(line, op.from![0] * w, op.from![1] * h + i * size * 1.25));
  }
  ctx.restore();
}

/**
 * Paint every visible op into `ctx` (whose drawing area is w×h pixels). Does not clear the canvas,
 * so the recorder can paint annotations on top of the video frame.
 */
export function renderAnnotations(ctx: CanvasRenderingContext2D, ops: AnnotationOp[], w: number, h: number, now: number): void {
  if (!ops.length || w <= 0 || h <= 0) return;
  const unit = unitFor(w, h);
  for (const op of visibleOps(ops)) drawOne(ctx, op, w, h, unit, now);
}

// --- Hit testing (eraser) ---

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ids of visible ops under the point (normalised x/y) within `radius` pixels. */
export function hitTest(ops: readonly AnnotationOp[], nx: number, ny: number, w: number, h: number, radius: number, now: number): string[] {
  const unit = unitFor(w, h);
  const px = nx * w;
  const py = ny * h;
  const hits: string[] = [];
  for (const op of visibleOps(ops)) {
    if (op.kind === "laser" || opAlpha(op, now) <= 0) continue;
    const lw = (op.width ?? 6) * unit * (op.tool === "highlighter" ? 3 : 1);
    const tol = radius + lw / 2;
    let hit = false;
    if (op.kind === "stroke" && op.points?.length) {
      const pts = op.points;
      if (pts.length === 1) hit = Math.hypot(px - pts[0][0] * w, py - pts[0][1] * h) <= tol;
      for (let i = 1; i < pts.length && !hit; i++) {
        hit = distToSegment(px, py, pts[i - 1][0] * w, pts[i - 1][1] * h, pts[i][0] * w, pts[i][1] * h) <= tol;
      }
    } else if (op.kind === "shape" && op.from && op.to) {
      const [x0, y0, x1, y1] = [op.from[0] * w, op.from[1] * h, op.to[0] * w, op.to[1] * h];
      if (op.tool === "arrow") hit = distToSegment(px, py, x0, y0, x1, y1) <= tol;
      else if (op.tool === "ellipse") {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = Math.max(1, Math.abs(x1 - x0) / 2);
        const ry = Math.max(1, Math.abs(y1 - y0) / 2);
        const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
        hit = Math.abs(d - 1) * Math.min(rx, ry) <= tol;
      } else {
        const l = Math.min(x0, x1);
        const r = Math.max(x0, x1);
        const t = Math.min(y0, y1);
        const b = Math.max(y0, y1);
        hit =
          distToSegment(px, py, l, t, r, t) <= tol ||
          distToSegment(px, py, r, t, r, b) <= tol ||
          distToSegment(px, py, r, b, l, b) <= tol ||
          distToSegment(px, py, l, b, l, t) <= tol;
      }
    } else if (op.kind === "text" && op.from && op.text) {
      const size = textFontPx(op, unit);
      const lines = op.text.split("\n");
      const tw = Math.max(...lines.map((l) => l.length)) * size * 0.58;
      const th = lines.length * size * 1.25;
      const x = op.from[0] * w;
      const y = op.from[1] * h;
      hit = px >= x - radius && px <= x + tw + radius && py >= y - radius && py <= y + th + radius;
    }
    if (hit) hits.push(op.id);
  }
  return hits;
}
