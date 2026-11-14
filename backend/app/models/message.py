import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class Message(UUIDPk, Timestamped, Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_channel_created", "channel_id", "created_at"),
        # Thread pages: WHERE parent_id = ? ORDER BY created_at.
        Index("ix_messages_parent_created", "parent_id", "created_at"),
        # Drafts & sent ("my messages, newest first") and reaction activity (my messages' reactions).
        Index("ix_messages_author_created", "author_id", "created_at"),
        # Full-text search (Phase 2). Swap for a dedicated engine only when this stops scaling.
        Index(
            "ix_messages_body_fts",
            func.to_tsvector(text("'english'"), text("body")),
            postgresql_using="gin",
        ),
    )

    # workspace_id is denormalised on purpose: every tenant-scoped query filters on it.
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    # Set when the message is a thread reply.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    # "user" for people's messages, "system" for app-generated ones (call cards, call notes).
    # System messages can't be edited or deleted and never count as unread.
    kind: Mapped[str] = mapped_column(String(16), default="user", server_default="user")
    # Structured payload for system messages, e.g. {"type": "call", "call_id": ...}.
    meta: Mapped[dict | None] = mapped_column(JSONB)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MessageReaction(UUIDPk, Timestamped, Base):
    __tablename__ = "message_reactions"
    # The unique constraint's leading column also serves lookups by message_id.
    __table_args__ = (UniqueConstraint("message_id", "user_id", "emoji"),)

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    emoji: Mapped[str] = mapped_column(String(32))


class Attachment(UUIDPk, Timestamped, Base):
    """A file in object storage. Uploaded first (message_id NULL), then linked to a message."""

    __tablename__ = "attachments"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    uploader_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), index=True
    )
    storage_key: Mapped[str] = mapped_column(String(1024), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(BigInteger)
    # Recorded media: "voice" (voice message), "video_clip" or "screen_recording"; NULL for
    # ordinary files.
    kind: Mapped[str | None] = mapped_column(String(16))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # Up to 64 amplitude samples (0-100) for drawing a voice message's waveform.
    waveform: Mapped[list[int] | None] = mapped_column(JSONB)


class MessageMention(UUIDPk, Base):
    """One row per `<@user_id>` in a message body, so the Activity view is an index scan."""

    __tablename__ = "message_mentions"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id"),
        Index("ix_message_mentions_user_ws_created", "user_id", "workspace_id", "created_at"),
    )

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    # Copied from the message so the index can serve "newest mentions first".
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
