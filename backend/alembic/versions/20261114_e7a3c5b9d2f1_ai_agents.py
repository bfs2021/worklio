"""AI agents (Wave B): bot users (users.is_bot) and live-caption transcript segments

Revision ID: e7a3c5b9d2f1
Revises: d4e8a1c7b2f9
Create Date: 2026-11-14 18:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'e7a3c5b9d2f1'
down_revision: str | None = 'd4e8a1c7b2f9'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'users', sa.Column('is_bot', sa.Boolean(), server_default='false', nullable=False)
    )
    op.create_table('call_transcript_segments',
    sa.Column('call_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['call_id'], ['calls.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        'ix_call_transcript_segments_call_started',
        'call_transcript_segments',
        ['call_id', 'started_at'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_call_transcript_segments_call_started', table_name='call_transcript_segments')
    op.drop_table('call_transcript_segments')
    op.drop_column('users', 'is_bot')
