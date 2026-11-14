"""lists v2: card priority/cover/custom fields, field definitions, subtasks, card comments

Revision ID: c8d2f6a1b9e4
Revises: f1b2c3d4e5a6
Create Date: 2026-11-14 15:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'c8d2f6a1b9e4'
down_revision: str | None = 'f1b2c3d4e5a6'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    ]


def upgrade() -> None:
    op.add_column('board_cards', sa.Column('priority', sa.String(length=16), server_default='none', nullable=False))
    op.add_column('board_cards', sa.Column('cover_color', sa.String(length=32), nullable=True))
    op.add_column(
        'board_cards',
        sa.Column('fields', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
    )

    op.create_table(
        'board_fields',
        sa.Column('board_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=50), nullable=False),
        sa.Column('type', sa.String(length=16), nullable=False),
        sa.Column('options', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
        sa.Column('position', sa.Double(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(['board_id'], ['boards.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_board_fields_board_id'), 'board_fields', ['board_id'], unique=False)

    op.create_table(
        'board_subtasks',
        sa.Column('card_id', sa.Uuid(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('done', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('assignee_id', sa.Uuid(), nullable=True),
        sa.Column('position', sa.Double(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(['assignee_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['card_id'], ['board_cards.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_board_subtasks_card_position', 'board_subtasks', ['card_id', 'position'], unique=False)

    op.create_table(
        'board_card_comments',
        sa.Column('card_id', sa.Uuid(), nullable=False),
        sa.Column('author_id', sa.Uuid(), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['card_id'], ['board_cards.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_board_card_comments_card_created', 'board_card_comments', ['card_id', 'created_at'], unique=False
    )


def downgrade() -> None:
    op.drop_index('ix_board_card_comments_card_created', table_name='board_card_comments')
    op.drop_table('board_card_comments')
    op.drop_index('ix_board_subtasks_card_position', table_name='board_subtasks')
    op.drop_table('board_subtasks')
    op.drop_index(op.f('ix_board_fields_board_id'), table_name='board_fields')
    op.drop_table('board_fields')
    op.drop_column('board_cards', 'fields')
    op.drop_column('board_cards', 'cover_color')
    op.drop_column('board_cards', 'priority')
