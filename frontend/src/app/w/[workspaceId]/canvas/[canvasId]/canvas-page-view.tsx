"use client";

import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { CanvasView } from "@/components/canvas/canvas-editor";
import { ViewPage } from "@/components/views/view-shell";

/** A standalone canvas: full-page editor with title/emoji, sharing, comments and outline. */
export function CanvasPageView() {
  const { workspaceId, canvasId } = useParams<{ workspaceId: string; canvasId: string }>();
  const search = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const templateId = search.get("template");

  const onTemplateApplied = useCallback(() => router.replace(pathname, { scroll: false }), [router, pathname]);
  const onDeleted = useCallback(() => router.push(`/w/${workspaceId}/canvas`), [router, workspaceId]);

  return (
    <ViewPage label="Canvas">
      <CanvasView
        canvasId={canvasId}
        variant="page"
        templateId={templateId}
        onTemplateApplied={templateId ? onTemplateApplied : undefined}
        onDeleted={onDeleted}
      />
    </ViewPage>
  );
}
