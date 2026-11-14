"use client";

import { useState } from "react";

import { useOptionalWorkspace } from "@/components/workspace/provider";
import { cn } from "@/lib/utils";

/** Stable 32-bit hash of a user id. */
function hashOf(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** The user's hue (0–359), shared by every avatar of theirs. */
export function hueFor(id: string) {
  return hashOf(id) % 360;
}

/** Bracketed asides such as "(you)", "[bot]", "{guest}", "（外部）" and anything after an unclosed opener. */
const ASIDES = /\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|<[^>]*>|（[^）]*）|【[^】]*】/gu;
const UNCLOSED = /[([{<（【].*$/u;
/** Word separators: whitespace and common punctuation between name parts ("Jean-Luc", "a.b", "x / y"). */
const SEPARATORS = /[\s\-‐-―_.,;:/\\|·•+&]+/u;
/** The first letter of a word, with any combining marks (accents, Indic vowel signs) that belong to it. */
const FIRST_LETTER = /\p{L}\p{M}*/u;

/**
 * Initials for a display name: up to `max` letters (first and last word), uppercased.
 * Robust to decorated labels ("Alice Johnson (you)" -> "AJ"), emoji, digits and punctuation
 * ("🚀 Launch team!" -> "LT"), e-mail addresses ("alice@acme.io" -> "A") and non-Latin
 * scripts ("Ελένη Παππά" -> "ΕΠ", "王小明" -> "王"). Falls back to "?".
 */
export function initials(name: string | null | undefined, max: 1 | 2 = 2) {
  let s = (name ?? "").normalize("NFC").replace(ASIDES, " ").replace(UNCLOSED, " ").trim();
  // A bare e-mail address: only its local part is name-like.
  if (!/\s/u.test(s) && s.includes("@")) s = s.slice(0, s.indexOf("@"));
  const letters: string[] = [];
  for (const word of s.split(SEPARATORS)) {
    const m = FIRST_LETTER.exec(word);
    if (m) letters.push(m[0]);
  }
  if (!letters.length) return "?";
  const picked = max === 1 || letters.length === 1 ? [letters[0]] : [letters[0], letters[letters.length - 1]];
  return picked.join("").toLocaleUpperCase();
}

const SIZES = {
  xs: "size-4 rounded text-[8px]",
  sm: "size-[18px] rounded text-[8.5px]",
  md: "size-8 rounded-md text-[12.5px]",
  lg: "size-10 rounded-lg text-[15px]",
  xl: "size-16 rounded-lg text-[22px]",
} as const;

export type AvatarSize = keyof typeof SIZES;

/** Tiny avatars only have room for one letter. */
const ONE_LETTER: Partial<Record<AvatarSize, true>> = { xs: true, sm: true };

/**
 * A user's avatar: their photo when they have one, otherwise a soft tint of their hue with
 * their initials in a deeper shade. When `src` is omitted, the photo is looked up from the
 * current workspace's members (or `me`), so every call site picks up photos automatically.
 * Pass `src={null}` to force the initials avatar.
 */
export function UserAvatar({
  id,
  name,
  online,
  size = "md",
  className,
  ringClassName = "border-background",
  src,
}: {
  id: string;
  name: string;
  online?: boolean;
  size?: AvatarSize;
  className?: string;
  ringClassName?: string;
  src?: string | null;
}) {
  const ws = useOptionalWorkspace();
  const url =
    src !== undefined
      ? src
      : (ws?.memberById[id]?.avatar_url ?? (ws?.me?.id === id ? ws.me.avatar_url : null) ?? null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = !!url && failedSrc !== url;
  const text = initials(name, ONE_LETTER[size] ? 1 : 2);
  const small = size === "xs" || size === "sm";

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <span
        className={cn(
          "relative inline-flex items-center justify-center overflow-hidden leading-none font-semibold tracking-tight select-none",
          !showPhoto &&
            "bg-[hsl(var(--av-h)_70%_91%)] text-[hsl(var(--av-h)_48%_30%)] dark:bg-[hsl(var(--av-h)_32%_24%)] dark:text-[hsl(var(--av-h)_70%_80%)]",
          SIZES[size],
        )}
        style={{ "--av-h": hueFor(id) } as React.CSSProperties}
        aria-hidden
      >
        {showPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote, presigned, tiny; next/image adds nothing here
          <img
            src={url}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className="size-full object-cover"
            onError={() => setFailedSrc(url)}
          />
        ) : (
          <span>{text}</span>
        )}
        {/* Hairline inner border, drawn over photos too so light images keep an edge. */}
        <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-black/5 ring-inset dark:ring-white/10" />
      </span>
      {online !== undefined && (
        <PresenceDot
          online={online}
          className={cn(
            "absolute",
            small ? "-right-[3px] -bottom-[3px] size-2" : "-right-[3px] -bottom-[3px] size-2.5",
            ringClassName,
          )}
        />
      )}
    </span>
  );
}

/**
 * Presence dot. `size-*` sets the dot itself; the 2px border (colour via a `border-*` class,
 * e.g. the surface behind the avatar) sits outside it as a crisp cut-out ring.
 */
export function PresenceDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      title={online ? "Active" : "Away"}
      role="img"
      aria-label={online ? "Active" : "Away"}
      className={cn(
        "box-content inline-block size-2 rounded-full border-2 border-background",
        online ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-500",
        className,
      )}
    />
  );
}
