"use client";

import { BrandLockup } from "@/components/ui/brand-mark";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-chrome px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      style={{ backgroundImage: "var(--chrome-gradient)" }}
    >
      <BrandLockup />
      <Card className="w-full max-w-sm shadow-2xl">
        <ErrorState error={error} retry={retry} />
      </Card>
    </main>
  );
}
