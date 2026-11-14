"""One Excalidraw whiteboard per channel (also the board of that channel's calls).

Live collaboration goes over the WebSocket (`whiteboard.ops` / `whiteboard.pointer`, see
app.realtime.routes). Persistence is client-driven: clients debounce a PUT of the whole
scene with the `base_version` they last saw. If someone saved in between, the server answers
409 with the current scene so the client can merge (by element id, higher version wins) and
retry. Saving an identical scene is a no-op that doesn't bump the version.
"""

import json
import uuid

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DB, ChannelAccess, CurrentUser, ensure_not_archived
from app.core.config import settings
from app.models import Channel, Whiteboard
from app.realtime.hub import publish_to_channel
from app.schemas import WhiteboardIn, WhiteboardOut

router = APIRouter(tags=["whiteboard"])


def too_large_message() -> str:
    return f"Whiteboard too large (max {settings.max_whiteboard_bytes / (1024 * 1024):g} MB)"


async def get_or_create_whiteboard(db: AsyncSession, channel: Channel) -> Whiteboard:
    await db.execute(
        pg_insert(Whiteboard)
        .values(id=uuid.uuid4(), channel_id=channel.id, elements=[], version=0)
        .on_conflict_do_nothing(index_elements=["channel_id"])
    )
    await db.commit()
    return await db.scalar(select(Whiteboard).where(Whiteboard.channel_id == channel.id))


def _out(board: Whiteboard) -> dict:
    return WhiteboardOut.model_validate(board).model_dump(mode="json")


@router.get("/channels/{channel_id}/whiteboard", response_model=WhiteboardOut)
async def get_whiteboard(channel: ChannelAccess, db: DB) -> Whiteboard:
    return await get_or_create_whiteboard(db, channel)


@router.put(
    "/channels/{channel_id}/whiteboard",
    response_model=WhiteboardOut,
    responses={409: {"description": "Changed since base_version; body has the current whiteboard"}},
)
async def save_whiteboard(data: WhiteboardIn, channel: ChannelAccess, db: DB, user: CurrentUser):
    ensure_not_archived(channel)
    size = len(json.dumps(data.elements, separators=(",", ":"), ensure_ascii=False).encode())
    if size > settings.max_whiteboard_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large_message())
    current = await get_or_create_whiteboard(db, channel)
    if data.elements == current.elements:
        # Nothing changed: no version bump, so other clients don't see a false conflict.
        return _out(current)
    # Compare-and-swap on the version, so two concurrent saves can't both win.
    saved_id = await db.scalar(
        update(Whiteboard)
        .where(Whiteboard.id == current.id, Whiteboard.version == data.base_version)
        .values(
            elements=data.elements,
            version=Whiteboard.version + 1,
            updated_by=user.id,
            updated_at=func.now(),
        )
        .returning(Whiteboard.id)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    await db.refresh(current)
    out = _out(current)
    if not saved_id:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"detail": "Whiteboard changed", "whiteboard": out},
        )
    # Small notice only (the scene itself travels as whiteboard.ops): lets open boards learn
    # the new version so their next save doesn't conflict needlessly.
    await publish_to_channel(
        channel.id,
        {
            "type": "whiteboard.saved",
            "channel_id": str(channel.id),
            "version": out["version"],
            "user_id": str(user.id),
        },
    )
    return out
