import enum
import uuid
from typing import ClassVar

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, deferred, mapped_column

from app.models.base import Base, Timestamped, UUIDPk

EMPTY_DOC = {"type": "doc", "content": []}


class CanvasAccess(enum.StrEnum):
    workspace = "workspace"  # every full (non-guest) member of the workspace
    private = "private"  # the creator plus `canvas_members`
    channel = "channel"  # whoever can read `channel_id`


class Canvas(UUIDPk, Timestamped, Base):
    """A collaborative rich document.

    Either a channel's own canvas (`is_channel_canvas`, at most one per channel, access
    "channel"), or a standalone canvas shared with the workspace, a private member list, or a
    channel's audience.

    The live document is a Yjs doc: `ydoc_state` holds the merged, compacted update (pycrdt) and
    `ydoc_size` its length. `content`/`version` are the pre-Yjs TipTap JSON document saved with
    optimistic concurrency; it is kept so clients can seed the Yjs doc once while it is empty.
    """

    __tablename__ = "canvases"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (
        CheckConstraint(
            "access IN ('workspace', 'private', 'channel')", name="ck_canvases_access"
        ),
        CheckConstraint(
            "access <> 'channel' OR channel_id IS NOT NULL", name="ck_canvases_channel_access"
        ),
        CheckConstraint(
            "NOT is_channel_canvas OR (channel_id IS NOT NULL AND access = 'channel')",
            name="ck_canvases_channel_canvas",
        ),
        # One channel canvas per channel; any number of other canvases may point at a channel.
        Index(
            "uq_canvases_channel_canvas",
            "channel_id",
            unique=True,
            postgresql_where=text("is_channel_canvas"),
        ),
        Index("ix_canvases_workspace_updated", "workspace_id", "updated_at"),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), index=True
    )
    is_channel_canvas: Mapped[bool] = mapped_column(default=False, server_default="false")
    access: Mapped[str] = mapped_column(String(16), default=CanvasAccess.workspace.value)
    title: Mapped[str] = mapped_column(String(200), default="Canvas")
    emoji: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Legacy TipTap JSON (pre-Yjs), exposed as `legacy_content` for one-time seeding.
    content: Mapped[dict] = mapped_column(JSONB, default=lambda: dict(EMPTY_DOC))
    version: Mapped[int] = mapped_column(default=0, server_default="0")
    # Merged Yjs update for the whole document (None/empty = nothing written yet).
    ydoc_state: Mapped[bytes | None] = deferred(mapped_column(LargeBinary))
    ydoc_size: Mapped[int] = mapped_column(default=0, server_default="0")


class CanvasMember(Base):
    """Who a private canvas is shared with (besides its creator)."""

    __tablename__ = "canvas_members"

    canvas_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("canvases.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class CanvasComment(UUIDPk, Timestamped, Base):
    """A comment on a canvas. Root comments have `thread_id == id`; replies point at the root.

    `anchor_id` is the id of the comment mark the client put around the commented text
    (null for document-level comments); `quote` is a snapshot of that text.
    """

    __tablename__ = "canvas_comments"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (Index("ix_canvas_comments_canvas_created", "canvas_id", "created_at"),)

    canvas_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("canvases.id", ondelete="CASCADE"))
    thread_id: Mapped[uuid.UUID] = mapped_column(index=True)
    anchor_id: Mapped[str | None] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    quote: Mapped[str | None] = mapped_column(Text)
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    resolved: Mapped[bool] = mapped_column(default=False, server_default="false")
