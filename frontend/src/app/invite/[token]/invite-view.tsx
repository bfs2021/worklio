"use client";

import { AlertTriangle, ArrowRight, Link2Off, Loader2, LogOut } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

import { WorkspaceIcon } from "@/components/admin/controls";
import { BrandLockup } from "@/components/ui/brand-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { adminApi, adminErrorMessage, type InvitePreview } from "@/lib/admin";
import { AuthForm, type AuthMode } from "@/components/auth/auth-form";
import { ApiError, api, auth, signOut, type User } from "@/lib/api";

/* Auth token as an external store so SSR and the first client render agree (no hydration mismatch). */
const authListeners = new Set<() => void>();
const subscribeAuth = (fn: () => void) => {
  authListeners.add(fn);
  const onStorage = () => fn();
  window.addEventListener("storage", onStorage);
  return () => {
    authListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
};
const emitAuth = () => authListeners.forEach((fn) => fn());
const useToken = () =>
  useSyncExternalStore(
    subscribeAuth,
    () => auth.get(),
    () => null,
  );

type Load =
  | { kind: "loading" }
  | { kind: "ready"; invite: InvitePreview }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

export function InviteView() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    adminApi
      .previewInvite(token)
      .then((invite) => live && setState({ kind: "ready", invite }))
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) setState({ kind: "invalid" });
        else setState({ kind: "error", message: adminErrorMessage(err, "Couldn't load this invite") });
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);

  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-chrome px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      style={{ backgroundImage: "var(--chrome-gradient)" }}
    >
      <BrandLockup tagline="Where your team talks, together." />
      <Card className="w-full max-w-md shadow-2xl">
        <CardContent className="p-6">
          {state.kind === "loading" ? (
            <div className="flex flex-col items-center gap-3 py-8" aria-busy="true">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Checking your invite…</p>
            </div>
          ) : state.kind === "error" ? (
            <Problem
              icon={AlertTriangle}
              title="Something went wrong"
              body={state.message}
              action={
                <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              }
            />
          ) : state.kind === "invalid" || !state.invite.valid ? (
            <Problem
              icon={Link2Off}
              title={
                state.kind !== "ready"
                  ? "This invite link isn't valid"
                  : state.invite.reason === "revoked"
                    ? "This invite was revoked"
                    : state.invite.reason === "used_up"
                      ? "This invite has been used up"
                      : "This invite has expired"
              }
              body={
                state.kind === "ready"
                  ? `The link to join ${state.invite.workspace_name} has expired, been used up or been revoked. Ask ${state.invite.inviter_name || "whoever sent it"} for a new one.`
                  : "Double-check the link, or ask the person who invited you for a new one."
              }
              action={
                <Button variant="outline" render={<Link href="/" />} nativeButton={false}>
                  Go to Worklio
                </Button>
              }
            />
          ) : (
            <Join token={token} invite={state.invite} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Problem({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <Icon className="size-6" />
      </span>
      <h1 className="text-lg font-black">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

function Join({ token, invite }: { token: string; invite: InvitePreview }) {
  const router = useRouter();
  const authToken = useToken();
  const [me, setMe] = useState<{ token: string; user: User } | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authToken) return;
    let live = true;
    api<User>("/auth/me")
      .then((user) => live && setMe({ token: authToken, user }))
      .catch(() => {
        if (!live) return;
        emitAuth();
      });
    return () => {
      live = false;
    };
  }, [authToken]);

  const accept = async () => {
    setJoining(true);
    setError("");
    try {
      const { workspace_id } = await adminApi.acceptInvite(token);
      router.replace(`/w/${workspace_id}`);
    } catch (err) {
      setError(adminErrorMessage(err, "Couldn't join the workspace"));
      setJoining(false);
    }
  };

  const user = me && me.token === authToken ? me.user : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <WorkspaceIcon name={invite.workspace_name} url={invite.workspace_icon_url} size="lg" />
        <div>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{invite.inviter_name || "A teammate"}</span> invited you to join
          </p>
          <h1 className="mt-0.5 text-2xl font-black tracking-[-0.01em] break-words">{invite.workspace_name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {invite.role === "guest"
              ? "As a guest, you'll see only the channels you're invited to."
              : "You'll join as a member with access to public channels."}
          </p>
        </div>
      </div>

      {authToken && !user && !error ? (
        <div className="flex justify-center py-3">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading your account" />
        </div>
      ) : user || (authToken && error) ? (
        <div className="space-y-3">
          <Button className="h-10 w-full bg-send text-[15px] font-bold text-white hover:bg-send/90" onClick={accept} disabled={joining}>
            {joining ? <Loader2 className="animate-spin" /> : null}
            {joining ? "Joining…" : `Join ${invite.workspace_name}`}
            {!joining && <ArrowRight />}
          </Button>
          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            Signed in{user ? " as " : ""}<span className="font-semibold text-foreground">{user?.email}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 font-semibold text-link hover:underline"
              onClick={() => {
                void signOut();
                setMe(null);
                emitAuth();
              }}
            >
              <LogOut className="size-3" /> Use another account
            </button>
          </div>
        </div>
      ) : (
        <InviteAuth
          workspaceName={invite.workspace_name}
          onAuthed={() => {
            emitAuth();
            // Signed in from the invite: join straight away.
            void accept();
          }}
        />
      )}
    </div>
  );
}

function InviteAuth({ workspaceName, onAuthed }: { workspaceName: string; onAuthed: () => void }) {
  const [mode, setMode] = useState<AuthMode>("register");
  return (
    <div className="space-y-4 border-t pt-5">
      <p className="text-center text-sm font-bold">
        {mode === "register" ? `Create an account to join ${workspaceName}` : `Sign in to join ${workspaceName}`}
      </p>
      <AuthForm
        mode={mode}
        onModeChange={setMode}
        onSuccess={onAuthed}
        autoFocus={false}
        submitLabel={mode === "register" ? "Create account & join" : "Sign in & join"}
      />
    </div>
  );
}
