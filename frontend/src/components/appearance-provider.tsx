"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api, auth } from "@/lib/api";
import {
  appearanceScript,
  applyPreferences,
  DEFAULT_PREFERENCES,
  loadPreferences,
  type Preferences,
  resolveDark,
} from "@/lib/appearance";

type AppearanceCtx = {
  prefs: Preferences;
  dark: boolean;
  update: (patch: Partial<Preferences>) => void;
  /** Called once the signed-in user is known: server preferences win; otherwise upload local ones. */
  hydrateFromServer: (server: Partial<Preferences> | undefined) => void;
};

const Ctx = createContext<AppearanceCtx | null>(null);

/**
 * Applies saved appearance before first paint (no theme flash). It runs from the server HTML; if React
 * ever creates this element on the client (e.g. re-rendering the root after an error) it's marked as a
 * data block, since client-created scripts never run and React warns about them.
 */
export function AppearanceScript() {
  return (
    <script
      id="worklio-appearance"
      type={typeof window === "undefined" ? undefined : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: appearanceScript }}
    />
  );
}

export function useAppearance(): AppearanceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppearance must be used inside <AppearanceProvider>");
  return ctx;
}

function subscribeSystemTheme(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(() =>
    typeof window === "undefined" ? DEFAULT_PREFERENCES : loadPreferences(),
  );
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  // Server HTML is rendered with defaults; switch to saved preferences only after hydration.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const visible = hydrated ? prefs : DEFAULT_PREFERENCES;
  const pending = useRef<Partial<Preferences>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    applyPreferences(prefs);
  }, [prefs, systemDark]);

  const flush = useCallback(() => {
    const patch = pending.current;
    pending.current = {};
    if (!auth.get() || !Object.keys(patch).length) return;
    api("/auth/me/preferences", { method: "PATCH", body: JSON.stringify(patch) }).catch(() => {
      // keep local; it will be re-sent with the next change
      pending.current = { ...patch, ...pending.current };
    });
  }, []);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      const root = document.documentElement;
      root.classList.add("theme-transition");
      setTimeout(() => root.classList.remove("theme-transition"), 350);
      setPrefs((p) => ({ ...p, ...patch }));
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 600);
    },
    [flush],
  );

  const hydrateFromServer = useCallback(
    (server: Partial<Preferences> | undefined) => {
      if (server && Object.keys(server).length) {
        setPrefs({ ...DEFAULT_PREFERENCES, ...server });
      } else {
        pending.current = { ...loadPreferences() };
        flush();
      }
    },
    [flush],
  );

  return (
    <Ctx.Provider
      value={{ prefs: visible, dark: hydrated && (resolveDark(prefs) || (prefs.mode === "system" && systemDark)), update, hydrateFromServer }}
    >
      {children}
    </Ctx.Provider>
  );
}
