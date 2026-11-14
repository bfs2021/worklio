"""Messaging additions (Wave A2): pins, bookmarks, forwards, scheduled sends, polls, link
previews, edit history and user groups.

Each feature lives in its own table keyed by message id so the core `messages` table stays lean
and every extra is loaded in one batched query per page (see app.messaging_extras.enrich).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class MessagePin(Base):
    __tablename__ = "message_pins"
    __table_args__ = (Index("ix_message_pins_channel_pinned", "channel_id", "pinned_at"),)

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    pinned_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    pinned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ChannelBookmark(UUIDPk, Timestamped, Base):
    __tablename__ = "channel_bookmarks"
    __table_args__ = (Index("ix_channel_bookmarks_channel_position", "channel_id", "position"),)

    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(2048))
    emoji: Mapped[str | None] = mapped_column(String(32))
    position: Mapped[float] = mapped_column(Float)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class MessageForward(Base):
    """Marks a message as a forward and snapshots where it came from (the source may vanish)."""

    __tablename__ = "message_forwards"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"), index=True
    )
    source_channel_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    source_author_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    source_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    body_preview: Mapped[str] = mapped_column(Text)


class MessageRevision(UUIDPk, Base):
    """The body a message had before an edit (edited_at = when it was replaced)."""

    __tablename__ = "message_edits"
    __table_args__ = (Index("ix_message_edits_message_edited", "message_id", "edited_at"),)

    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    edited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScheduledMessage(UUIDPk, Timestamped, Base):
    __tablename__ = "scheduled_messages"
    __table_args__ = (
        # The beat task scans pending rows by due time; partial so sent history costs nothing.
        Index(
            "ix_scheduled_messages_due",
            "send_at",
            postgresql_where=text("status = 'pending'"),
        ),
        Index("ix_scheduled_messages_author_ws", "author_id", "workspace_id"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    # Uploads reserved for this message; the orphan sweeper leaves them alone while pending.
    attachment_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), default=list, server_default="{}"
    )
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # pending | sent | failed | cancelled
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    error: Mapped[str | None] = mapped_column(String(200))
    sent_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )


class Poll(UUIDPk, Timestamped, Base):
    __tablename__ = "polls"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), unique=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    question: Mapped[str] = mapped_column(String(300))
    multiple: Mapped[bool] = mapped_column(Boolean, default=False)
    anonymous: Mapped[bool] = mapped_column(Boolean, default=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PollOption(UUIDPk, Base):
    __tablename__ = "poll_options"
    __table_args__ = (Index("ix_poll_options_poll_position", "poll_id", "position"),)

    poll_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(String(140))


class PollVote(UUIDPk, Base):
    __tablename__ = "poll_votes"
    __table_args__ = (
        UniqueConstraint("option_id", "user_id"),
        Index("ix_poll_votes_poll_user", "poll_id", "user_id"),
    )

    poll_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"))
    option_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("poll_options.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MessageUnfurl(Base):
    """Link previews attached to one message.

    `urls` are the links found in the body (max 3, in order); `items` the fetched previews;
    `hidden_urls` previews the author dismissed (kept so an edit doesn't bring them back).
    """

    __tablename__ = "message_unfurls"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    urls: Mapped[list[str]] = mapped_column(JSONB, default=list)
    items: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    hidden_urls: Mapped[list[str]] = mapped_column(JSONB, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LinkPreview(Base):
    """Cache of fetched pages (24 h). `data` is null when the page had nothing to preview."""

    __tablename__ = "link_previews"

    url_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    url: Mapped[str] = mapped_column(Text)
    data: Mapped[dict | None] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserGroup(UUIDPk, Timestamped, Base):
    __tablename__ = "user_groups"
    __table_args__ = (UniqueConstraint("workspace_id", "handle"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    handle: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(80))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class UserGroupMember(Base):
    __tablename__ = "user_group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
