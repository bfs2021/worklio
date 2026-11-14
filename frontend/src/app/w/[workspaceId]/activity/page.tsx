import { Suspense } from "react";

import { ActivityView } from "./activity-view";

export default function ActivityPage() {
  return (
    <Suspense fallback={null}>
      <ActivityView />
    </Suspense>
  );
}
