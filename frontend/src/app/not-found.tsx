import Link from "next/link";

import { BrandLockup } from "@/components/ui/brand-mark";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-chrome px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      style={{ backgroundImage: "var(--chrome-gradient)" }}
    >
      <BrandLockup />
      <Card className="w-full max-w-sm text-center shadow-2xl">
        <CardContent className="space-y-2 py-2">
          <p className="text-5xl font-black text-muted-foreground/60">404</p>
          <h1 className="text-lg font-black">This page doesn&apos;t exist</h1>
          <p className="text-sm text-muted-foreground">The link may be broken, or the page may have been removed.</p>
          <Link
            href="/"
            className="mt-3 inline-flex h-9 items-center justify-center rounded-lg bg-send px-4 text-sm font-bold text-white hover:bg-send/90"
          >
            Back to Worklio
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
