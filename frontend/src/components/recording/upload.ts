import { API_URL, ApiError, api, type Attachment, auth, type Message } from "@/lib/api";

function extensionFor(type: string) {
  return type.includes("mp4") ? "mp4" : "webm";
}

export function recordingFileName(title: string, type: string) {
  const base =
    title
      .trim()
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .replace(/\s+/g, "_")
      .slice(0, 80) || `Screen_recording_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`;
  return `${base}.${extensionFor(type)}`;
}

/**
 * Upload with progress (fetch has no upload progress). Mirrors `uploadFile` in lib/api but sends
 * kind "screen_recording".
 */
export function uploadRecording(
  workspaceId: string,
  blob: Blob,
  { title, durationMs, onProgress, signal }: { title: string; durationMs: number; onProgress?: (p: number) => void; signal?: AbortSignal },
): Promise<Attachment> {
  const type = (blob.type || "video/webm").split(";")[0];
  const file = new File([blob], recordingFileName(title, type), { type });
  const form = new FormData();
  form.append("file", file);
  form.append("kind", "screen_recording");
  form.append("duration_ms", String(Math.max(0, Math.round(durationMs))));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/workspaces/${workspaceId}/uploads`);
    const token = auth.get();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as unknown as Attachment);
        return;
      }
      if (xhr.status === 401) auth.clear();
      const detail = typeof body.detail === "string" ? body.detail : xhr.statusText || "Upload failed";
      reject(new ApiError(xhr.status, detail, body));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export async function sendScreenRecording(opts: {
  workspaceId: string;
  channelId: string;
  parentId?: string;
  blob: Blob;
  durationMs: number;
  title: string;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}): Promise<Message> {
  const attachment = await uploadRecording(opts.workspaceId, opts.blob, opts);
  return api<Message>(`/channels/${opts.channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: opts.title.trim(), parent_id: opts.parentId ?? null, attachment_ids: [attachment.id] }),
  });
}

export function sendFailureMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 413) return "This recording is too large to send (max 300 MB). Try trimming it.";
  if (err instanceof Error && err.message) return `Couldn't send the recording: ${err.message}`;
  return "Couldn't send the recording.";
}
