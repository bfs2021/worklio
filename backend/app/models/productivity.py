"""Personal productivity: thread follows, activity read state, Later / to-dos, reminders,
per-channel preferences and custom sidebar sections.

Most of the Threads and Activity inboxes is *derived* from existing tables (messages,
mentions, reactions, call invites); the tables here only hold per-user state that can't be
derived (explicit follow/unfollow, read markers) and events that have no other source
(channel invites, delivered reminders).
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class ThreadSubscription(UUIDPk, Timestamped, Base):
    """A user's state for one thread: explicit follow/unfollow and when they last read it."""

    __tablename__ = "thread_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "root_id"),
        Index("ix_thread_subscriptions_root", "root_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    root_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    # True: followed explicitly, False: unfollowed explicitly, None: derived (authored the root,
    # replied, or was mentioned).
    following: Mapped[bool | None] = mapped_column()
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ActivityEvent(UUIDPk, Base):
    """Activity items with no other source of truth (channel invites, delivered reminders,
    huddle starts)."""

    __tablename__ = "activity_events"
    __table_args__ = (
        Index("ix_activity_events_user_ws_created", "user_id", "workspace_id", "created_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(32))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE")
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    meta: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ActivityRead(Base):
    """One activity item marked read (items older than ActivityState.all_read_at are read too)."""

    __tablename__ = "activity_reads"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ActivityState(Base):
    """Per user and workspace: everything up to `all_read_at` counts as read ("Mark all read")."""

    __tablename__ = "activity_states"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    all_read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SavedItem(UUIDPk, Timestamped, Base):
    """"Later": a saved message or a free-standing to-do."""

    __tablename__ = "saved_items"
    __table_args__ = (
        Index("ix_saved_items_user_ws_status", "user_id", "workspace_id", "status"),
        # Saving the same message twice returns the existing item.
        Index(
            "uq_saved_items_user_message",
            "user_id",
            "message_id",
            unique=True,
            postgresql_where=text("message_id IS NOT NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))  # "message" | "todo"
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )
    title: Mapped[str | None] = mapped_column(String(500))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(16), default="in_progress", server_default="in_progress"
    )
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    remind_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Reminder(UUIDPk, Timestamped, Base):
    __tablename__ = "reminders"
    __table_args__ = (
        # The delivery sweep: WHERE status = 'pending' AND remind_at <= now().
        Index(
            "ix_reminders_pending_due",
            "remind_at",
            postgresql_where=text("status = 'pending'"),
        ),
        Index("ix_reminders_user_ws_status", "user_id", "workspace_id", "status"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(String(500))
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    # Set when the reminder belongs to a Later item's remind_at.
    saved_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("saved_items.id", ondelete="CASCADE"), unique=True
    )
    status: Mapped[str] = mapped_column(String(16), default="pending", server_default="pending")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SidebarSection(UUIDPk, Timestamped, Base):
    __tablename__ = "sidebar_sections"
    __table_args__ = (Index("ix_sidebar_sections_user_ws", "user_id", "workspace_id"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    position: Mapped[float] = mapped_column(Float, default=0)
    collapsed: Mapped[bool] = mapped_column(default=False, server_default="false")


class ChannelPref(UUIDPk, Timestamped, Base):
    __tablename__ = "channel_prefs"
    __table_args__ = (
        UniqueConstraint("user_id", "channel_id"),
        Index("ix_channel_prefs_user_ws", "user_id", "workspace_id"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    muted: Mapped[bool] = mapped_column(default=False, server_default="false")
    # "default" (follow the user's global level) | "all" | "mentions" | "nothing"
    notify: Mapped[str] = mapped_column(String(16), default="default", server_default="default")
    starred: Mapped[bool] = mapped_column(default=False, server_default="false")
    section_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sidebar_sections.id", ondelete="SET NULL")
    )
