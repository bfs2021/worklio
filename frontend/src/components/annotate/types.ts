/**
 * Wire format for screen-share annotations.
 *
 * Ops travel over LiveKit data messages (topic "annotate", reliable) and are UPSERTS keyed by `id`:
 * a stroke that is still being drawn is re-sent with more points under the same id, so late
 * frames simply replace earlier ones.
 *
 * Coordinates are normalised to the annotated box (0..1 on both axes) so viewers with different
 * screen sizes line up. Widths are in "reference pixels" for a 1000px-wide box (see `unitFor`).
 *
 * Kinds:
 *  - stroke  tool "pen" | "highlighter"; `points` = [x, y][]
 *  - shape   tool "arrow" | "rect" | "ellipse"; `from` / `to`
 *  - text    `from` = top-left anchor, `text`
 *  - laser   `points` = [x, y, timeMs][] where timeMs is the sender's Date.now() of the sample;
 *            receivers re-base it onto their own clock (see Annotator)
 *  - erase   `text` = id of the op it removes
 *  - clear   removes everything drawn before it (for everyone)
 *  - undo    `text` = id of the op (stroke/shape/text/erase/clear) it cancels
 *
 * `t` is the sender's Date.now() when this version of the op was emitted. `fade` makes a finished
 * op fade out ~4 s after `t`.
 */
export type AnnotationOp = {
  kind: "stroke" | "shape" | "text" | "laser" | "erase" | "clear" | "undo";
  id: string;
  userId: string;
  color: string;
  tool?: string;
  points?: [number, number, number?][];
  from?: [number, number];
  to?: [number, number];
  text?: string;
  width?: number;
  fade?: boolean;
  t: number;
};

export type AnnotateTool = "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text" | "laser" | "eraser";

export type AnnotateUser = { id: string; name: string; color: string };

/** Laser trail lifetime. */
export const LASER_MS = 1000;
/** Finished ops with `fade` stay fully visible for this long … */
export const FADE_HOLD_MS = 4000;
/** … then fade out over this long. */
export const FADE_OUT_MS = 700;

export const SWATCHES = ["#f43f5e", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#18181b"] as const;

/** Stroke widths (reference pixels) offered in the toolbar. */
export const WIDTHS = [
  { id: "s", label: "Thin", value: 3 },
  { id: "m", label: "Medium", value: 6 },
  { id: "l", label: "Thick", value: 12 },
] as const;

/** Pixel size of one reference unit for a box of this size. */
export function unitFor(w: number, h: number): number {
  // Average the axes so very wide/tall boxes don't produce extreme widths.
  return Math.max(0.25, (w + h * (16 / 9)) / 2 / 1000);
}

/** Stable per-user color for name tags / default ink. */
export function colorForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  const palette = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  return palette[h % palette.length];
}

export function newOpId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
