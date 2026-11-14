import type { JSONContent } from "@tiptap/react";
import { useEffect, useState } from "react";

export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** ProseMirror needs at least one block; the server starts canvases as `{type: "doc", content: []}`. */
export function normalizeDoc(content: JSONContent | null | undefined): JSONContent {
  if (!content || content.type !== "doc" || !Array.isArray(content.content) || content.content.length === 0)
    return EMPTY_DOC;
  return content;
}

/** True when a doc has no visible content (only empty paragraphs). */
export function isDocEmpty(content: JSONContent | null | undefined): boolean {
  const blocks = normalizeDoc(content).content ?? [];
  return blocks.every((b) => b.type === "paragraph" && !b.content?.length);
}

/** Order-insensitive deep equality (Postgres JSONB does not preserve key order). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // Treat missing and null/undefined attrs as equal.
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "Mar 4". */
export function timeAgo(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

/** A clock that ticks every `intervalMs`, for relative timestamps and presence expiry. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
