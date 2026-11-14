import type { CSSProperties } from "react";

/**
 * The call UI is always dark, whatever the app theme. Put `CALL_THEME_CLASS` + `CALL_THEME_VARS`
 * on any call surface (the window, and every popover/menu it portals out) so shared components
 * inside it (Composer, MessageList, Board, notes) pick up the same dark, glassy tokens.
 */
export const CALL_THEME_CLASS = "dark";

export const CALL_THEME_VARS = {
  "--background": "#121215",
  "--foreground": "#e8e8ea",
  "--card": "#18181c",
  "--card-foreground": "#e8e8ea",
  "--popover": "#1a1a1f",
  "--popover-foreground": "#ececef",
  "--muted": "rgb(255 255 255 / 0.06)",
  "--muted-foreground": "#a1a1aa",
  "--accent": "rgb(255 255 255 / 0.08)",
  "--accent-foreground": "#fafafa",
  "--border": "rgb(255 255 255 / 0.09)",
  "--input": "rgb(255 255 255 / 0.12)",
  "--ring": "rgb(255 255 255 / 0.35)",
  "--composer-border": "rgb(255 255 255 / 0.14)",
  "--composer-toolbar": "rgb(255 255 255 / 0.03)",
  colorScheme: "dark",
} as CSSProperties;

/** Classes for popovers / menus opened from the call UI. */
export const CALL_POPOVER_CLASS =
  "dark bg-zinc-900/95 text-zinc-100 ring-white/10 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.7)] backdrop-blur-xl";
