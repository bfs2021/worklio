"use client";

import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { brandButtonClass } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, auth, type Workspace } from "@/lib/api";

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [hasWorkspaces, setHasWorkspaces] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth.get()) {
      router.replace("/login");
      return;
    }
    api<Workspace[]>("/workspaces")
      .then((l) => setHasWorkspaces(l.length > 0))
      .catch(() => {
        // api() drops the token on a 401: an expired session goes back to sign-in.
        if (!auth.get()) router.replace("/login");
      });
  }, [router]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const ws = await api<Workspace>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      router.replace(`/w/${ws.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create a workspace"
      subtitle="A workspace is where your team talks. You can invite people right after."
    >
      <form onSubmit={create} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ws-name" className="text-sm font-semibold">
            Company or team name
          </Label>
          <Input
            id="ws-name"
            className="h-11"
            placeholder="Acme Inc."
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoFocus
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            {error}
          </p>
        )}
        <button type="submit" className={brandButtonClass} disabled={busy || !name.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? "Creating your workspace…" : "Create workspace"}
          {!busy && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
        </button>
        {hasWorkspaces && (
          <Link href="/" className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:underline">
            <ArrowLeft className="size-3.5" /> Back to your workspaces
          </Link>
        )}
      </form>
    </AuthShell>
  );
}
