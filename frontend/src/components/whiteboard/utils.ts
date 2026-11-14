import { hueFor } from "@/components/chat/user-avatar";

import type { WhiteboardElement } from "./types";

export const MAX_ELEMENTS = 10_000;

export function isElement(v: unknown): v is WhiteboardElement {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.version === "number" && Number.isInteger(o.version);
}

/** Keep only well-formed elements (objects with a string id and an int version). */
export function sanitizeElements(v: unknown): WhiteboardElement[] {
  return Array.isArray(v) ? v.filter(isElement) : [];
}

/** Excalidraw's own rule: higher version wins, ties go to the lower versionNonce. */
export function newer<T extends WhiteboardElement>(a: T, b: T): T {
  if (b.version !== a.version) return b.version > a.version ? b : a;
  const na = typeof a.versionNonce === "number" ? a.versionNonce : 0;
  const nb = typeof b.versionNonce === "number" ? b.versionNonce : 0;
  return nb < na ? b : a;
}

/** Cursor / selection colours for a collaborator, derived from their user id. */
export function collaboratorColor(userId: string): { background: string; stroke: string } {
  const h = hueFor(userId);
  return { background: `hsl(${h} 78% 56%)`, stroke: `hsl(${h} 70% 38%)` };
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "whiteboard"
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
