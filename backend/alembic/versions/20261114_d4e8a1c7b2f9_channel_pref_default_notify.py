"""channel_prefs.notify "default" level; messages(author_id, created_at) index

Starring, muting or moving a channel creates its prefs row; with "all" as the default that
row silently overrode the user's global level and the channel notified on every message.

Revision ID: d4e8a1c7b2f9
Revises: a2b7c4d9e1f0
Create Date: 2026-11-14 12:00:00
"""
from collections.abc import Sequence

from alembic import op

revision: str = "d4e8a1c7b2f9"
down_revision: str | None = "a2b7c4d9e1f0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("channel_prefs", "notify", server_default="default")
    # Rows written before this revision could not choose "all" deliberately (no UI shipped
    # without the default), so treat them as following the global level.
    op.execute("UPDATE channel_prefs SET notify = 'default' WHERE notify = 'all'")
    # Sent view + reaction activity filter messages by author, newest first.
    op.create_index("ix_messages_author_created", "messages", ["author_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_messages_author_created", table_name="messages")
    op.execute("UPDATE channel_prefs SET notify = 'all' WHERE notify = 'default'")
    op.alter_column("channel_prefs", "notify", server_default="all")
