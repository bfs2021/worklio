"""merge heads: workspace admin + AI providers/installs

Both branches were built in parallel on top of canvases v2 (d9e3a7c1f5b2); this no-op revision
joins them so `alembic upgrade head` has a single target.

Revision ID: b3e9f1a6c2d4
Revises: a7d1e4c2b8f3, a7f3d2c9e8b1
Create Date: 2026-11-14
"""

from collections.abc import Sequence

revision: str = "b3e9f1a6c2d4"
down_revision: str | Sequence[str] | None = ("a7d1e4c2b8f3", "a7f3d2c9e8b1")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
