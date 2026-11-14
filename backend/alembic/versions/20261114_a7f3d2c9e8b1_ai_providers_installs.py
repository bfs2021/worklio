"""Worklio AI providers (per-workspace encrypted keys, toggles, limits) and agent installs

Revision ID: a7f3d2c9e8b1
Revises: d9e3a7c1f5b2
Create Date: 2026-11-14 22:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a7f3d2c9e8b1"
down_revision: str | None = "d9e3a7c1f5b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workspace_ai_settings",
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=20), nullable=True),
        sa.Column("model", sa.String(length=120), nullable=True),
        sa.Column("api_key_encrypted", sa.LargeBinary(), nullable=True),
        sa.Column("key_hint", sa.String(length=8), nullable=True),
        sa.Column(
            "features",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("per_user_limit", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("workspace_id"),
    )
    op.create_table(
        "ai_agent_installs",
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("channel_id", sa.Uuid(), nullable=True),
        sa.Column("installed_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["channel_id"], ["channels.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["installed_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_ai_agent_installs_channel",
        "ai_agent_installs",
        ["workspace_id", "channel_id"],
        unique=True,
        postgresql_where=sa.text("channel_id IS NOT NULL"),
    )
    op.create_index(
        "uq_ai_agent_installs_everywhere",
        "ai_agent_installs",
        ["workspace_id"],
        unique=True,
        postgresql_where=sa.text("channel_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_ai_agent_installs_everywhere", table_name="ai_agent_installs")
    op.drop_index("uq_ai_agent_installs_channel", table_name="ai_agent_installs")
    op.drop_table("ai_agent_installs")
    op.drop_table("workspace_ai_settings")
