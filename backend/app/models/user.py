from datetime import datetime
from typing import ClassVar

from sqlalchemy import DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import settings
from app.models.base import Base, Timestamped, UUIDPk


class User(UUIDPk, Timestamped, Base):
    __tablename__ = "users"
    # Fetch server-generated updated_at with RETURNING, so it can be read after a commit
    # without a lazy load (it versions the avatar URL).
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    hashed_password: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True)
    # Workspace bots (the "Worklio" AI agent): never log in; clients list them for
    # @mentions but leave them out of people counts.
    is_bot: Mapped[bool] = mapped_column(default=False, server_default="false")
    # UI preferences (theme, font, density…) synced across devices. Validated by schemas.Preferences.
    preferences: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    # Profile.
    title: Mapped[str | None] = mapped_column(String(100))
    pronouns: Mapped[str | None] = mapped_column(String(40))
    timezone: Mapped[str | None] = mapped_column(String(64))  # IANA name, e.g. "Europe/Berlin"
    phone: Mapped[str | None] = mapped_column(String(40))
    status_emoji: Mapped[str | None] = mapped_column(String(32))
    status_text: Mapped[str | None] = mapped_column(String(100))
    status_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Do not disturb: notifications are paused until this moment (NULL = off).
    dnd_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Object-storage key of the profile photo (internal; clients get `avatar_url`).
    avatar_key: Mapped[str | None] = mapped_column(String(1024))

    @property
    def avatar_url(self) -> str | None:
        """Absolute, cache-busting URL of the photo (served by GET /users/{id}/avatar)."""
        if not self.avatar_key:
            return None
        version = int(self.updated_at.timestamp()) if self.updated_at else 0
        return f"{settings.api_public_url.rstrip('/')}/users/{self.id}/avatar?v={version}"
