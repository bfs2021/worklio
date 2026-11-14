import { Suspense } from "react";

import { UnreadsView } from "./unreads-view";

export default function UnreadsPage() {
  return (
    <Suspense fallback={null}>
      <UnreadsView />
    </Suspense>
  );
}
