import { Suspense } from "react";

import { HuddlesView } from "./huddles-view";

export default function HuddlesPage() {
  return (
    <Suspense fallback={null}>
      <HuddlesView />
    </Suspense>
  );
}
