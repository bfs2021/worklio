import asyncio
import uuid

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse

from app.api.deps import DB
from app.core import storage
from app.models import User

router = APIRouter(prefix="/users", tags=["users"])

_EXT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}


@router.get("/{user_id}/avatar", status_code=status.HTTP_302_FOUND)
async def get_avatar(user_id: uuid.UUID, db: DB) -> RedirectResponse:
    """Unauthenticated so it works as an <img src>: redirects to a short-lived presigned URL."""
    user = await db.get(User, user_id)
    if not user or not user.is_active or not user.avatar_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No photo")
    ext = user.avatar_key.rsplit(".", 1)[-1]
    content_type = _EXT_TYPES.get(ext, storage.DEFAULT_CONTENT_TYPE)
    url = await asyncio.to_thread(
        storage.presigned_get, user.avatar_key, f"avatar.{ext}", content_type
    )
    # The URL is versioned (?v=...), so the browser may reuse the redirect while it's signed.
    max_age = storage.PRESIGNED_TTL_SECONDS // 2
    return RedirectResponse(
        url, status.HTTP_302_FOUND, headers={"Cache-Control": f"private, max-age={max_age}"}
    )
