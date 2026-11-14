"use client";

import { useEffect, useState } from "react";

import { useWorkspace } from "@/components/workspace/provider";
import { canvasApi } from "@/lib/canvas";
import { errorMessage } from "@/lib/toast";

import { CanvasError, CanvasSkeleton, CanvasView } from "./canvas-editor";

/**
 * The channel's Canvas tab: resolves (or creates) the channel canvas, then opens the same live,
 * collaborative editor used by standalone canvases. Remounts per channel so no state leaks.
 */
export function CanvasTab({ channelId }: { channelId: string }) {
  return <ChannelCanvas key={channelId} channelId={channelId} />;
}

function ChannelCanvas({ channelId }: { channelId: string }) {
  const { channels } = useWorkspace();
  const archived = channels.find((c) => c.id === channelId)?.is_archived ?? false;
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    canvasApi.forChannel(channelId).then(
      (c) => {
        if (!live) return;
        setCanvasId(c.id);
        setError("");
      },
      (err) => live && setError(errorMessage(err, "Couldn't load the canvas")),
    );
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  if (error && !canvasId)
    return (
      <CanvasError
        title="Couldn't load the canvas"
        message={error}
        onRetry={() => {
          setError("");
          setAttempt((n) => n + 1);
        }}
      />
    );
  if (!canvasId) return <CanvasSkeleton />;
  return <CanvasView canvasId={canvasId} variant="channel" readOnly={archived} />;
}
