"use client";

import { AlertCircle, ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";

import { Input } from "@/components/ui/input";
import { api, ApiError, auth, type Session } from "@/lib/api";
import { cn } from "@/lib/utils";

export type AuthMode = "login" | "register";

/** Primary button on the signed-out pages: the same green "send" colour as the app's primary actions. */
export const brandButtonClass =
  "group flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-send px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-send/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none active:bg-send/80 disabled:opacity-60";

const LAST_EMAIL_KEY = "worklio.lastEmail";

function rememberedEmail(): string {
  try {
    return typeof window === "undefined" ? "" : (localStorage.getItem(LAST_EMAIL_KEY) ?? "");
  } catch {
    return "";
  }
}

/** Human wording for the auth API's failures. */
function friendlyError(err: unknown, mode: AuthMode): { text: string; switchTo?: AuthMode } {
  if (err instanceof ApiError) {
    if (err.status === 401) return { text: "That email and password don't match. Check them and try again." };
    if (err.status === 409) return { text: "There's already an account with this email.", switchTo: "login" };
    if (err.status === 429) return { text: "Too many attempts. Wait a minute, then try again." };
    if (err.status === 422) return { text: "Check the highlighted fields and try again." };
    if (err.status >= 500) return { text: "Worklio is having trouble right now. Try again in a moment." };
  }
  if (err instanceof TypeError) return { text: "Can't reach Worklio. Check your connection and try again." };
  return { text: mode === "login" ? "Couldn't sign you in. Try again." : "Couldn't create your account. Try again." };
}

/** 0–4 score with a label; only shown while creating an account. */
function passwordStrength(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: "" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < 8) return { score: 1, label: `${8 - pw.length} more character${8 - pw.length === 1 ? "" : "s"}` };
  return { score: Math.max(score, 1), label: ["", "Weak", "Fair", "Good", "Strong"][Math.max(score, 1)] };
}

function Field({
  id,
  label,
  trailing,
  children,
}: {
  id: string;
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">
          {label}
        </label>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/**
 * Email + password sign-in / sign-up. Stores the session (access + refresh token) and calls
 * `onSuccess`. Used by /login, /signup and the invite page.
 */
export function AuthForm({
  mode,
  onModeChange,
  onSuccess,
  submitLabel,
  autoFocus = true,
}: {
  mode: AuthMode;
  onModeChange: (m: AuthMode) => void;
  onSuccess: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const uid = useId();
  // `email: null` = untouched: show the last-used email, but only after hydration
  // (localStorage isn't available during the server render).
  const [form, setForm] = useState<{ email: string | null; password: string; full_name: string }>({
    email: null,
    password: "",
    full_name: "",
  });
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const email = form.email ?? (hydrated ? rememberedEmail() : "");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; switchTo?: AuthMode } | null>(null);
  const register = mode === "register";
  const strength = register ? passwordStrength(form.password) : null;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    if (error) setError(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const cleanEmail = email.trim();
      const body = register
        ? { email: cleanEmail, password: form.password, full_name: form.full_name.trim() }
        : { email: cleanEmail, password: form.password };
      const session = await api<Session>(`/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      auth.setSession(session);
      try {
        localStorage.setItem(LAST_EMAIL_KEY, cleanEmail);
      } catch {}
      onSuccess();
    } catch (err) {
      setError(friendlyError(err, mode));
      setPending(false);
    }
  }

  const caps = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.("CapsLock") ?? false);

  return (
    <form onSubmit={submit} className="space-y-4" noValidate={false}>
      {register && (
        <Field id={`${uid}-name`} label="Full name">
          <Input
            id={`${uid}-name`}
            key="full_name"
            className="h-11"
            placeholder="Jane Cooper"
            value={form.full_name}
            onChange={set("full_name")}
            autoComplete="name"
            autoFocus={autoFocus}
            maxLength={200}
            required
          />
        </Field>
      )}
      <Field id={`${uid}-email`} label={register ? "Work email" : "Email"}>
        <Input
          id={`${uid}-email`}
          className="h-11"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={set("email")}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus && !register}
          required
        />
      </Field>
      <Field
        id={`${uid}-password`}
        label="Password"
        trailing={
          strength?.label ? (
            <span
              className={cn(
                "text-xs font-medium",
                strength.score <= 1 ? "text-destructive" : strength.score === 2 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400",
              )}
              aria-live="polite"
            >
              {strength.label}
            </span>
          ) : null
        }
      >
        <div className="relative">
          <Input
            id={`${uid}-password`}
            className="h-11 pr-11"
            type={showPassword ? "text" : "password"}
            placeholder={register ? "At least 8 characters" : "Your password"}
            value={form.password}
            onChange={set("password")}
            onKeyDown={caps}
            onKeyUp={caps}
            autoComplete={register ? "new-password" : "current-password"}
            minLength={8}
            maxLength={128}
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {register && (
          <div className="flex gap-1 pt-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full bg-muted transition-colors",
                  strength && strength.score >= i &&
                    (strength.score <= 1 ? "bg-destructive" : strength.score === 2 ? "bg-amber-500" : "bg-emerald-500"),
                )}
              />
            ))}
          </div>
        )}
        {capsLock && <p className="text-xs font-medium text-amber-600 dark:text-amber-400">Caps Lock is on</p>}
      </Field>

      {error && (
        <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p>
            {error.text}{" "}
            {error.switchTo && (
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  onModeChange(error.switchTo!);
                }}
              >
                Sign in instead
              </button>
            )}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className={brandButtonClass}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {pending
          ? register
            ? "Creating your account…"
            : "Signing in…"
          : (submitLabel ?? (register ? "Create account" : "Sign in"))}
        {!pending && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        {register ? "Already have an account? " : "New to Worklio? "}
        <button
          type="button"
          disabled={pending}
          className="font-semibold text-link hover:underline disabled:opacity-50"
          onClick={() => {
            setError(null);
            onModeChange(register ? "login" : "register");
          }}
        >
          {register ? "Sign in" : "Create an account"}
        </button>
      </p>
    </form>
  );
}
