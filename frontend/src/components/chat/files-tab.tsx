"use client";

import { FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { isVideoAttachment } from "@/components/voice/media";
import { VideoClipAttachment } from "@/components/voice/video-clip-player";
import { useWorkspace } from "@/components/workspace/provider";
import { api, type ChannelFile } from "@/lib/api";
import { dayLabel, formatBytes } from "@/lib/messages";
import { errorMessage } from "@/lib/toast";

export function FilesTab({ channelId }: { channelId: string }) {
  const { memberById } = useWorkspace();
  const [files, setFiles] = useState<ChannelFile[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api<ChannelFile[]>(`/channels/${channelId}/files`)
      .then((f) => {
        if (!live) return;
        setFiles(f);
        setError("");
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [channelId, attempt]);

  if (error && !files)
    return (
      <div className="m-auto max-w-xs p-8 text-center">
        <p className="font-bold">Couldn&apos;t load files</p>
        <p className="mb-3 text-sm text-muted-foreground">{error}</p>
        <button
          onClick={() => {
            setError("");
            setAttempt((n) => n + 1);
          }}
          className="rounded-md border px-3 py-1.5 text-sm font-bold hover:bg-muted"
        >
          Try again
        </button>
      </div>
    );
  if (!files)
    return (
      <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />
    );
  if (!files.length)
    return (
      <div className="m-auto max-w-xs p-8 text-center">
        <FileText className="mx-auto mb-3 size-10 text-muted-foreground" />
        <p className="font-bold">No files yet</p>
        <p className="text-sm text-muted-foreground">
          Files shared in this conversation will show up here.
        </p>
      </div>
    );

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] sm:gap-3">
        {files.map((f) =>
          isVideoAttachment(f) ? (
            // Recorded clips / screen recordings play inline (a player can't live inside a link).
            <div
              key={f.id}
              className="overflow-hidden rounded-lg border hover:shadow-md"
            >
              <VideoClipAttachment
                attachment={f}
                className="aspect-video! w-full rounded-none shadow-none ring-0 sm:w-full"
              />
              <div className="p-2 sm:p-2.5">
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-bold hover:underline"
                  title={f.filename}
                >
                  {f.kind === "screen_recording"
                    ? "Screen recording"
                    : f.kind === "video_clip"
                      ? "Video clip"
                      : f.filename}
                </a>
                <div className="truncate text-xs text-muted-foreground">
                  {memberById[f.uploader_id]?.full_name ?? "Someone"} ·{" "}
                  {dayLabel(f.created_at)} · {formatBytes(f.size)}
                </div>
              </div>
            </div>
          ) : (
            <a
              key={f.id}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              className="overflow-hidden rounded-lg border hover:shadow-md"
            >
              <div className="flex h-24 items-center justify-center bg-muted sm:h-28">
                {f.content_type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL
                  <img
                    src={f.url}
                    alt={f.filename}
                    className="size-full object-cover"
                  />
                ) : (
                  <FileText className="size-10 text-sky-600" />
                )}
              </div>
              <div className="p-2 sm:p-2.5">
                <div className="truncate text-sm font-bold">{f.filename}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {memberById[f.uploader_id]?.full_name ?? "Someone"} ·{" "}
                  {dayLabel(f.created_at)} · {formatBytes(f.size)}
                </div>
              </div>
            </a>
          ),
        )}
      </div>
    </div>
  );
}
