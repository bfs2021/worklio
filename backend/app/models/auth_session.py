import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPk


class AuthSession(UUIDPk, Base):
    """A signed-in device. Holds the hash of its current refresh token (never the token).

    Refresh tokens rotate on every use. All tokens issued for one sign-in share a `family_id`;
    presenting an already-rotated token means it leaked, so the whole family is revoked.
    """

    __tablename__ = "auth_sessions"
    __table_args__ = (Index("ix_auth_sessions_user_family", "user_id", "family_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    family_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_agent: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Set when this token was exchanged for a new one (rotation) or signed out.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
