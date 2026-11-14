import asyncio
import json
import logging
import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Form, HTTPException, UploadFile, status

from app.api.deps import DB, CurrentUser, WorkspaceMembership, get_workspace_membership
from app.core import storage
from app.core.config import settings
from app.models import Attachment, Message
from app.schemas import AttachmentOut
from app.services import attachment_out

log = logging.getLogger(__name__)
router = APIRouter(tags=["uploads"])

# Multipart framing (boundaries, part headers) on top of the file bytes.
MULTIPART_OVERHEAD_BYTES = 64 * 1024


UploadKind = Literal["voice", "video_clip", "screen_recording"]
# Kinds that may use the larger recording limit (settings.max_recording_bytes).
RECORDING_KINDS = frozenset({"video_clip", "screen_recording"})


def max_bytes_for(kind: str | None) -> int:
    return settings.max_recording_bytes if kind in RECORDING_KINDS else settings.max_upload_bytes


def max_upload_request_bytes() -> int:
    """Transport-level cap: the largest per-kind limit (the kind field may follow the file)."""
    largest = max(settings.max_upload_bytes, settings.max_recording_bytes)
    return largest + MULTIPART_OVERHEAD_BYTES


def too_large_message(kind: str | None = None) -> str:
    mb = max_bytes_for(kind) / (1024 * 1024)
    return f"File too large (max {mb:g} MB)"


def request_too_large_message() -> str:
    mb = max(settings.max_upload_bytes, settings.max_recording_bytes) / (1024 * 1024)
    return f"File too large (max {mb:g} MB)"


# Voice notes and video clips are short; screen recordings may run much longer.
MAX_MEDIA_DURATION_MS = 600_000  # 10 minutes
MAX_RECORDING_DURATION_MS = 4 * 60 * 60 * 1000  # 4 hours
MAX_WAVEFORM_SAMPLES = 64
# Recorded media must be one of these (browsers' MediaRecorder output, plus mp3 for voice).
MEDIA_TYPES = {
    "voice": frozenset({"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"}),
    "video_clip": frozenset({"video/webm", "video/mp4"}),
    "screen_recording": frozenset({"video/webm", "video/mp4"}),
}


def _parse_waveform(raw: str | None) -> list[int] | None:
    if raw is None or not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        value = None
    if (
        not isinstance(value, list)
        or len(value) > MAX_WAVEFORM_SAMPLES
        or not all(type(v) is int and 0 <= v <= 100 for v in value)
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"waveform must be a JSON array of at most {MAX_WAVEFORM_SAMPLES} integers 0-100",
        )
    return value


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")[:200] or "file"


@router.post(
    "/workspaces/{workspace_id}/uploads",
    response_model=AttachmentOut,
    status_code=status.HTTP_201_CREATED,
)
async def upload_file(
    workspace_id: uuid.UUID,
    file: UploadFile,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
    kind: Annotated[UploadKind | None, Form()] = None,
    duration_ms: Annotated[int | None, Form(ge=0, le=MAX_RECORDING_DURATION_MS)] = None,
    waveform: Annotated[str | None, Form(max_length=1024)] = None,
) -> AttachmentOut:
    """Upload through the API (simple, works without bucket CORS).

    Voice and video messages add `kind` ("voice" | "video_clip" | "screen_recording"),
    `duration_ms` and, for voice, `waveform` (JSON array of up to 64 ints 0-100) as extra form
    fields. Video clips and screen recordings may be up to `max_recording_bytes` (300 MB);
    everything else is capped at `max_upload_bytes`.

    Oversized request bodies are refused before they are read by `UploadSizeLimitMiddleware`.
    At larger scale, switch to presigned PUT URLs so bytes go straight to S3.
    """
    if file.size is None or file.size > max_bytes_for(kind):
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large_message(kind))
    max_duration = MAX_RECORDING_DURATION_MS if kind == "screen_recording" else MAX_MEDIA_DURATION_MS
    if duration_ms is not None and duration_ms > max_duration:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"duration_ms must be at most {max_duration}",
        )
    filename = _safe_name(file.filename or "file")
    content_type = storage.normalize_content_type(file.content_type)
    samples = _parse_waveform(waveform)
    if kind and content_type not in MEDIA_TYPES[kind]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"A {kind.replace('_', ' ')} must be one of: {', '.join(sorted(MEDIA_TYPES[kind]))}",
        )
    key = f"{workspace_id}/{uuid.uuid4()}/{filename}"
    await asyncio.to_thread(storage.upload, key, file.file, content_type)

    att = Attachment(
        workspace_id=workspace_id,
        uploader_id=user.id,
        storage_key=key,
        filename=filename,
        content_type=content_type,
        size=file.size,
        kind=kind,
        duration_ms=duration_ms,
        waveform=samples,
    )
    db.add(att)
    try:
        await db.commit()
    except Exception:
        # Don't leave an object in the bucket that no row points at.
        await db.rollback()
        try:
            await asyncio.to_thread(storage.delete, key)
        except Exception:
            log.exception("Could not delete orphaned upload %s", key)
        raise
    url = await asyncio.to_thread(storage.presigned_get, key, filename, content_type)
    return attachment_out(att, url)


@router.get("/attachments/{attachment_id}/url", response_model=AttachmentOut)
async def refresh_attachment_url(attachment_id: uuid.UUID, db: DB, user: CurrentUser):
    """A freshly signed URL for an attachment (download links expire after an hour).

    Documents such as canvases store the attachment id next to the URL and call this when the
    stored link has expired. A file linked to a message is readable only by people who can
    read that message's channel; an unlinked upload (canvas or card image) by members of its
    workspace. Anything else is a 404, so ids can't be probed.
    """
    from app.productivity import can_read_channel  # heavy import graph; keep it lazy

    att = await db.get(Attachment, attachment_id)
    if att is None or not await get_workspace_membership(db, att.workspace_id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    if att.message_id is not None:
        message = await db.get(Message, att.message_id)
        if message is None or not await can_read_channel(db, message.channel_id, user.id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    url = await asyncio.to_thread(
        storage.presigned_get, att.storage_key, att.filename, att.content_type
    )
    return attachment_out(att, url)
