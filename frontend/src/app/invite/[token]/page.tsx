import type { Metadata } from "next";
import { Suspense } from "react";

import { InviteView } from "./invite-view";

export const metadata: Metadata = { title: "Join a workspace · Worklio" };

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteView />
    </Suspense>
  );
}
