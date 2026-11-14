import { Suspense } from "react";

import { CanvasPageView } from "./canvas-page-view";

export default function CanvasPage() {
  return (
    <Suspense fallback={null}>
      <CanvasPageView />
    </Suspense>
  );
}
