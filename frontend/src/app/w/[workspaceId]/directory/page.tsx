import { Suspense } from "react";

import { DirectoryView } from "./directory-view";

export default function DirectoryPage() {
  return (
    <Suspense fallback={null}>
      <DirectoryView />
    </Suspense>
  );
}
