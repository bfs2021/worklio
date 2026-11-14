import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DB, CurrentUser
from app.core import ratelimit, sessions, storage
from app.core.config import settings
from app.core.security import (
    burn_password_check,
    hash_password,
    verify_password,
)
from app.models import User
from app.profiles import broadcast_user_updated
from app.schemas import (
    LoginIn,
    Preferences,
    ProfileUpdate,
    RefreshIn,
    RegisterIn,
    StatusIn,
    TokenOut,
    UserOut,
)
from app.schemas_productivity import DndIn

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# Accepted photo formats: content type -> (file extension, magic-byte check).
AVATAR_TYPES = {
    "image/png": ("png", lambda h: h.startswith(b"\x89PNG\r\n\x1a\n")),
    "image/jpeg": ("jpg", lambda h: h.startswith(b"\xff\xd8\xff")),
    "image/gif": ("gif", lambda h: h[:6] in (b"GIF87a", b"GIF89a")),
    "image/webp": ("webp", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WEBP"),
}


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def register(data: RegisterIn, db: DB, request: Request) -> TokenOut:
    await ratelimit.hit("register-ip", ratelimit.client_ip(request), settings.register_rate_limit_per_ip)
    email = data.email.lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(email=email, full_name=data.full_name, hashed_password=hash_password(data.password))
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:  # concurrent registration with the same email
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered") from None
    out = await sessions.issue(db, user.id, request)
    await db.commit()
    return out


@router.post("/login", response_model=TokenOut)
async def login(data: LoginIn, db: DB, request: Request) -> TokenOut:
    email = data.email.lower()
    await ratelimit.hit("login-ip", ratelimit.client_ip(request), settings.login_rate_limit_per_ip)
    await ratelimit.hit("login-email", email, settings.login_rate_limit_per_email)
    user = await db.scalar(select(User).where(User.email == email))
    if not user:
        burn_password_check(data.password)  # same timing as a wrong password
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    if not verify_password(data.password, user.hashed_password) or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    out = await sessions.issue(db, user.id, request)
    await db.commit()
    return out


@router.post("/refresh", response_model=TokenOut)
async def refresh(data: RefreshIn, db: DB, request: Request) -> TokenOut:
    """Exchange a refresh token for a new access + refresh pair (the old one stops working)."""
    await ratelimit.hit("refresh-ip", ratelimit.client_ip(request), settings.refresh_rate_limit_per_ip)
    return await sessions.rotate(db, data.refresh_token, request)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(data: RefreshIn, db: DB) -> None:
    """Sign this device out. Works with an expired access token; unknown tokens are a no-op."""
    await sessions.revoke(db, data.refresh_token)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.patch("/me/preferences", response_model=UserOut)
async def update_preferences(data: Preferences, db: DB, user: CurrentUser) -> User:
    """Merge the given fields into the user's preferences (`null` clears a field, e.g. a custom accent)."""
    changes = data.model_dump(exclude_unset=True)
    merged = {**(user.preferences or {}), **changes}
    user.preferences = {k: v for k, v in merged.items() if v is not None}
    await db.commit()
    return user


@router.patch("/me", response_model=UserOut)
async def update_profile(data: ProfileUpdate, db: DB, user: CurrentUser) -> User:
    """Update profile fields; omitted fields are untouched and "" clears an optional one."""
    changes = data.model_dump(exclude_unset=True)
    if changes.get("full_name", "") is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "full_name can't be empty")
    for field, value in changes.items():
        setattr(user, field, value)
    await db.commit()
    await broadcast_user_updated(db, user)
    return user


@router.put("/me/status", response_model=UserOut)
async def set_status(data: StatusIn, db: DB, user: CurrentUser) -> User:
    if data.emoji is None and data.text is None:
        user.status_emoji = user.status_text = user.status_expires_at = None
    else:
        user.status_emoji, user.status_text = data.emoji, data.text
        user.status_expires_at = data.expires_at
    await db.commit()
    await broadcast_user_updated(db, user)
    return user


@router.put("/me/dnd", response_model=UserOut)
async def set_dnd(data: DndIn, db: DB, user: CurrentUser) -> User:
    """Pause notifications until `until` (future, at most a year away); null turns DND off."""
    user.dnd_until = data.until
    await db.commit()
    await broadcast_user_updated(db, user)
    return user


@router.delete("/me/status", response_model=UserOut)
async def clear_status(db: DB, user: CurrentUser) -> User:
    user.status_emoji = user.status_text = user.status_expires_at = None
    await db.commit()
    await broadcast_user_updated(db, user)
    return user


def avatar_too_large_message() -> str:
    return f"Photo too large (max {settings.max_avatar_bytes / (1024 * 1024):g} MB)"


async def _delete_object(key: str | None) -> None:
    if not key:
        return
    try:
        await asyncio.to_thread(storage.delete, key)
    except Exception:
        log.exception("Could not delete avatar object %s", key)


@router.post("/me/avatar", response_model=UserOut)
async def upload_avatar(file: UploadFile, db: DB, user: CurrentUser) -> User:
    """Set the profile photo (PNG, JPEG, WebP or GIF up to 5 MB). Replaces any previous one."""
    if file.size is None or file.size > settings.max_avatar_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, avatar_too_large_message())
    content_type = storage.normalize_content_type(file.content_type)
    kind = AVATAR_TYPES.get(content_type)
    head = await file.read(16)
    await file.seek(0)
    if not kind or not kind[1](head):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Use a PNG, JPEG, WebP or GIF image"
        )
    key = f"avatars/{user.id}/{uuid.uuid4()}.{kind[0]}"
    await asyncio.to_thread(storage.upload, key, file.file, content_type)
    old_key, user.avatar_key = user.avatar_key, key
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        await _delete_object(key)
        raise
    await _delete_object(old_key)
    await broadcast_user_updated(db, user)
    return user


@router.delete("/me/avatar", response_model=UserOut)
async def delete_avatar(db: DB, user: CurrentUser) -> User:
    old_key, user.avatar_key = user.avatar_key, None
    await db.commit()
    await _delete_object(old_key)
    await broadcast_user_updated(db, user)
    return user
