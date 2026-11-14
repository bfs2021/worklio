"use client";

import { ErrorState } from "@/components/ui/error-state";

/** Renders inside the workspace shell, so the rail, sidebar and top bar stay usable. */
export default function WorkspaceError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto">
      <ErrorState error={error} retry={retry} />
    </div>
  );
}
