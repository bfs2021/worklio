import { Suspense } from "react";

import { CanvasesView } from "./canvases-view";

export default function CanvasesPage() {
  return (
    <Suspense fallback={null}>
      <CanvasesView />
    </Suspense>
  );
}
