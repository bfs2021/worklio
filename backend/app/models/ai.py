"""Worklio AI: persisted Ask conversations and per-request token usage."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk


class AIConversation(UUIDPk, Timestamped, Base):
    """One "Ask Worklio" conversation. Private to the user who started it."""

    __tablename__ = "ai_conversations"
    __table_args__ = (
        Index("ix_ai_conversations_user_ws_updated", "user_id", "workspace_id", "updated_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(200))


class AITurn(UUIDPk, Base):
    """A question ("user") or an answer ("assistant") in a conversation."""

    __tablename__ = "ai_turns"
    __table_args__ = (Index("ix_ai_turns_conversation_created", "conversation_id", "created_at"),)

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ai_conversations.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    # Citation items exactly as streamed in the "citations" event (assistant turns only).
    citations: Mapped[list | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AIUsage(UUIDPk, Base):
    """Tokens used by one Claude request, for cost reporting per user / workspace / feature."""

    __tablename__ = "ai_usage"
    __table_args__ = (
        Index("ix_ai_usage_ws_created", "workspace_id", "created_at"),
        Index("ix_ai_usage_user_created", "user_id", "created_at"),
    )

    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    feature: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(80))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
