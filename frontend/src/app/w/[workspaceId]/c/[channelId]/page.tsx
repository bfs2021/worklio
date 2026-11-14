import { Suspense } from "react";

import { ChannelView } from "./channel-view";

export default function ChannelPage() {
  return (
    <Suspense fallback={null}>
      <ChannelView />
    </Suspense>
  );
}
