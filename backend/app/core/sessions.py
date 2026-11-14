"""Refresh-token sessions.

Access tokens are short-lived JWTs. A refresh token is 256 random bits handed to the client
once; only its SHA-256 is stored. Every refresh rotates it. If a token that was already rotated
comes back, someone else has a copy, so every token from that sign-in (its family) is revoked.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import create_access_token
from app.models import AuthSession, User
from app.schemas import TokenOut


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _user_agent(request: Request | None) -> str | None:
    ua = request.headers.get("user-agent") if request else None
    return ua[:200] if ua else None


async def issue(
    db: AsyncSession,
    user_id: uuid.UUID,
    request: Request | None = None,
    family_id: uuid.UUID | None = None,
) -> TokenOut:
    """Create a session row and return a fresh access + refresh pair. Caller commits."""
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            user_id=user_id,
            family_id=family_id or uuid.uuid4(),
            token_hash=_hash(token),
            user_agent=_user_agent(request),
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    return TokenOut(
        access_token=create_access_token(user_id),
        refresh_token=token,
        expires_in=settings.access_token_expire_minutes * 60,
    )


def _invalid() -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, "session_expired")


async def rotate(db: AsyncSession, token: str, request: Request | None = None) -> TokenOut:
    now = datetime.now(UTC)
    row = await db.scalar(
        select(AuthSession).where(AuthSession.token_hash == _hash(token)).with_for_update()
    )
    if row is None:
        raise _invalid()
    if row.revoked_at is not None:
        # Reuse of a rotated token: treat the whole sign-in as compromised.
        await revoke_family(db, row.user_id, row.family_id)
        await db.commit()
        raise _invalid()
    if row.expires_at <= now:
        raise _invalid()
    user = await db.get(User, row.user_id)
    if user is None or not user.is_active or user.is_bot:
        row.revoked_at = now
        await db.commit()
        raise _invalid()
    row.revoked_at = now
    out = await issue(db, row.user_id, request, family_id=row.family_id)
    await db.commit()
    return out


async def revoke_family(db: AsyncSession, user_id: uuid.UUID, family_id: uuid.UUID) -> None:
    await db.execute(
        update(AuthSession)
        .where(
            AuthSession.user_id == user_id,
            AuthSession.family_id == family_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )


async def revoke(db: AsyncSession, token: str) -> None:
    """Sign out this device: end the sign-in the token belongs to. Unknown tokens are ignored."""
    row = await db.scalar(select(AuthSession).where(AuthSession.token_hash == _hash(token)))
    if row is not None:
        await revoke_family(db, row.user_id, row.family_id)
        await db.commit()
