import uuid
from datetime import date, datetime
from typing import ClassVar

from sqlalchemy import Date, DateTime, Double, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class Board(UUIDPk, Timestamped, Base):
    """Kanban board; at most one per channel."""

    __tablename__ = "boards"

    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE"), unique=True
    )


class BoardColumn(UUIDPk, Timestamped, Base):
    __tablename__ = "board_columns"

    board_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(50))
    # Fractional ordering: a move sets a value between its neighbours.
    position: Mapped[float] = mapped_column(Double)
    color: Mapped[str | None] = mapped_column(String(32))


class BoardCard(UUIDPk, Timestamped, Base):
    __tablename__ = "board_cards"
    __mapper_args__: ClassVar[dict] = {"eager_defaults": True}
    __table_args__ = (Index("ix_board_cards_column_position", "column_id", "position"),)

    board_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    column_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("board_columns.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    due_date: Mapped[date | None] = mapped_column(Date)
    labels: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    position: Mapped[float] = mapped_column(Double)
    completed: Mapped[bool] = mapped_column(default=False, server_default="false")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    # Lists v2: "urgent" | "high" | "medium" | "low" | "none".
    priority: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    cover_color: Mapped[str | None] = mapped_column(String(32))
    # Custom field values keyed by BoardField id (as a string). Validated per field type.
    fields: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")


class BoardField(UUIDPk, Timestamped, Base):
    """Custom field definition shared by every card of a board."""

    __tablename__ = "board_fields"

    board_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(50))
    # "text" | "number" | "select" | "multi_select" | "person" | "date" | "checkbox" | "url"
    type: Mapped[str] = mapped_column(String(16))
    # Select types only: [{id, label, color}].
    options: Mapped[list[dict]] = mapped_column(JSONB, default=list, server_default="[]")
    position: Mapped[float] = mapped_column(Double)


class BoardSubtask(UUIDPk, Timestamped, Base):
    __tablename__ = "board_subtasks"
    __table_args__ = (Index("ix_board_subtasks_card_position", "card_id", "position"),)

    card_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("board_cards.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200))
    done: Mapped[bool] = mapped_column(default=False, server_default="false")
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    position: Mapped[float] = mapped_column(Double)


class BoardCardComment(UUIDPk, Timestamped, Base):
    __tablename__ = "board_card_comments"
    __table_args__ = (Index("ix_board_card_comments_card_created", "card_id", "created_at"),)

    card_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("board_cards.id", ondelete="CASCADE"))
    author_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    # Mentions use the message encoding: <@user-uuid>.
    body: Mapped[str] = mapped_column(Text)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
