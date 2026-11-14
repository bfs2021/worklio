/** Camera effects offered in the Effects panel. Order here is the order of the picker grid. */

export type EffectId =
  | "none"
  | "blur-light"
  | "blur-strong"
  | "bg-office"
  | "bg-aurora"
  | "bg-bookshelf"
  | "bg-mountains"
  | "bg-beach"
  | "bg-plum"
  | "custom";

export type EffectDef =
  | { id: "none"; label: string; kind: "none" }
  | { id: EffectId; label: string; kind: "blur"; radius: number }
  | { id: EffectId; label: string; kind: "image"; src: string };

export const BLUR_EFFECTS: EffectDef[] = [
  { id: "blur-light", label: "Slight blur", kind: "blur", radius: 10 },
  { id: "blur-strong", label: "Blur", kind: "blur", radius: 25 },
];

export const BACKGROUND_EFFECTS: (EffectDef & { kind: "image" })[] = [
  { id: "bg-office", label: "Office", kind: "image", src: "/backgrounds/office.svg" },
  { id: "bg-aurora", label: "Aurora", kind: "image", src: "/backgrounds/aurora.svg" },
  { id: "bg-bookshelf", label: "Bookshelf", kind: "image", src: "/backgrounds/bookshelf.svg" },
  { id: "bg-mountains", label: "Mountains", kind: "image", src: "/backgrounds/mountains.svg" },
  { id: "bg-beach", label: "Beach", kind: "image", src: "/backgrounds/beach.svg" },
  { id: "bg-plum", label: "Worklio plum", kind: "image", src: "/backgrounds/plum.svg" },
];

export const NONE_EFFECT: EffectDef = { id: "none", label: "None", kind: "none" };

const ALL: EffectDef[] = [NONE_EFFECT, ...BLUR_EFFECTS, ...BACKGROUND_EFFECTS];
const IDS = new Set<string>([...ALL.map((e) => e.id), "custom"]);

export function isEffectId(v: unknown): v is EffectId {
  return typeof v === "string" && IDS.has(v);
}

export function effectDef(id: EffectId): EffectDef | undefined {
  return ALL.find((e) => e.id === id);
}

export function effectLabel(id: EffectId): string {
  return id === "custom" ? "Your image" : (effectDef(id)?.label ?? "None");
}

/** Uploaded backgrounds: accepted types and size limit. */
export const CUSTOM_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CUSTOM_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
