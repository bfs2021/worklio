"""Per-workspace Worklio AI configuration and the @worklio agent's installs.

`workspace_ai_settings` holds one row per workspace that an admin configured: the provider
(anthropic | gemini | deepseek), the model, the provider API key **encrypted** with Fernet
(see app/ai/secrets.py; the plaintext is never stored, returned or logged), feature toggles
and the per-user request budget.

`ai_agent_installs` works like a Slack app install: a row with a channel_id adds the agent to
that channel; a row with channel_id NULL ("everywhere") covers every public channel.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, LargeBinary, String, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPk


class WorkspaceAISettings(Base):
    __tablename__ = "workspace_ai_settings"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    provider: Mapped[str | None] = mapped_column(String(20))
    model: Mapped[str | None] = mapped_column(String(120))
    api_key_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    # Last 4 characters of the key, shown as "…abcd" so admins can tell keys apart.
    key_hint: Mapped[str | None] = mapped_column(String(8))
    # Feature toggles; missing keys mean "on" (see app/ai/workspace.py FEATURE_KEYS).
    features: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text("'{}'::jsonb"))
    # AI requests per user per rate-limit window (10 minutes). NULL = server default.
    per_user_limit: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class AIAgentInstall(UUIDPk, Base):
    __tablename__ = "ai_agent_installs"
    __table_args__ = (
        # One install per channel, and at most one "everywhere" install per workspace.
        Index(
            "uq_ai_agent_installs_channel",
            "workspace_id",
            "channel_id",
            unique=True,
            postgresql_where=text("channel_id IS NOT NULL"),
        ),
        Index(
            "uq_ai_agent_installs_everywhere",
            "workspace_id",
            unique=True,
            postgresql_where=text("channel_id IS NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE")
    )
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channels.id", ondelete="CASCADE")
    )
    installed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
