import { Suspense } from "react";

import { FilesView } from "./files-view";

export default function FilesPage() {
  return (
    <Suspense fallback={null}>
      <FilesView />
    </Suspense>
  );
}
