"""Audio/video calls on top of the per-channel LiveKit room ("huddle-<channel_id>").

At most one live (ringing/active) call per channel, enforced by a partial unique index.
Who is *currently* in the room lives in Redis (app.realtime.huddles); everyone who ever
joined is kept here in `joined_ids`.
"""

import enum
import uuid
from datetime import datetime
from typing import ClassVar

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk

EMPTY_NOTES = {"type": "doc", "content": []}


class CallKind(enum.StrEnum):
    audio = "audio"
    video = "video"


class CallStatus(enum.StrEnum):
    ringing = "ringing"
    active = "active"
    ended = "ended"
    missed = "missed"
    declined = "declined"
    cancelled = "cancelled"


LIVE_CALL_STATUSES = (CallStatus.ringing, CallStatus.active)


class InviteStatus(enum.StrEnum):
    ringing = "ringing"
    accepted = "accepted"
    declined = "declined"
    missed = "missed"
    cancelled = "cancelled"


class Call(UUIDPk, Timestamped, Base):
    __tablename__ = "calls"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (
        # One live call per channel (the channel has exactly one LiveKit room).
        Index(
            "uq_calls_live_channel",
            "channel_id",
            unique=True,
            postgresql_where=text("status IN ('ringing', 'active')"),
        ),
        Index("ix_calls_channel_started", "channel_id", "started_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16), default=CallKind.audio)
    status: Mapped[str] = mapped_column(String(16), default=CallStatus.active)
    started_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # First time someone other than the caller joined (duration counts from here).
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    joined_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(PG_UUID(as_uuid=True)), default=list, server_default="{}"
    )
    # The call card (system message) and, once the call ended with notes, its notes reply.
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    notes_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    # Collaborative notes (TipTap JSON), saved with optimistic concurrency like canvases.
    notes: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(EMPTY_NOTES))
    notes_version: Mapped[int] = mapped_column(default=0, server_default="0")
    notes_updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    notes_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CallInvite(UUIDPk, Timestamped, Base):
    __tablename__ = "call_invites"
    __table_args__ = (
        UniqueConstraint("call_id", "user_id"),
        # "What is ringing for me" and the expiry sweep.
        Index("ix_call_invites_user_status", "user_id", "status"),
    )

    call_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("calls.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    invited_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), default=InviteStatus.ringing)
    # While ringing: when it turns into "missed".
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
