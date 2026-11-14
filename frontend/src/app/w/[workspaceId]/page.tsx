import { Suspense } from "react";

import { WorkspaceIndex } from "./workspace-index";

export default function WorkspacePage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceIndex />
    </Suspense>
  );
}
