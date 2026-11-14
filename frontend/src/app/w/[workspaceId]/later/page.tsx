import { Suspense } from "react";

import { LaterView } from "./later-view";

export default function LaterPage() {
  return (
    <Suspense fallback={null}>
      <LaterView />
    </Suspense>
  );
}
