"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AuthForm, type AuthMode } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { auth } from "@/lib/api";

/** Only same-site paths are allowed as a post-sign-in destination (no open redirects). */
function nextPath(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

const COPY: Record<AuthMode, { title: string; subtitle: string }> = {
  login: { title: "Welcome back", subtitle: "Sign in to pick up where your team left off." },
  register: { title: "Create your account", subtitle: "Start a workspace for your team in under a minute." },
};

export function AuthPage({ mode }: { mode: AuthMode }) {
  const router = useRouter();

  // Already signed in: go straight to the app.
  useEffect(() => {
    if (auth.get() || auth.refreshToken()) router.replace(nextPath());
  }, [router]);

  return (
    <AuthShell title={COPY[mode].title} subtitle={COPY[mode].subtitle}>
      <AuthForm
        key={mode}
        mode={mode}
        onModeChange={(m) => {
          const qs = typeof window === "undefined" ? "" : window.location.search;
          router.replace(`${m === "login" ? "/login" : "/signup"}${qs}`);
        }}
        onSuccess={() => router.replace(nextPath())}
      />
    </AuthShell>
  );
}
