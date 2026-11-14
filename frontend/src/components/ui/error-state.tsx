"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/** Body of an error boundary: what happened, a retry, and a way home. */
export function ErrorState({ error, retry, homeHref = "/" }: { error: unknown; retry: () => void; homeHref?: string }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  return (
    <div className="mx-auto max-w-sm p-6 text-center">
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-7" />
      </div>
      <h1 className="text-lg font-black">Something went wrong</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This part of Worklio hit an unexpected error. Trying again usually fixes it.
      </p>
      {digest && <p className="mt-2 font-mono text-xs text-muted-foreground">Error ID: {digest}</p>}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={() => retry()} className="bg-send text-white hover:bg-send/90">
          <RotateCcw className="size-4" /> Try again
        </Button>
        <Link
          href={homeHref}
          className="inline-flex h-8 items-center justify-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
