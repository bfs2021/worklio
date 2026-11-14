"""canvases v2: multi-canvas (workspace/private/channel access), Yjs state, members, comments

Existing per-channel canvases become channel canvases (is_channel_canvas, access "channel")
in their channel's workspace; their TipTap JSON stays in `content` for one-time Yjs seeding.

Revision ID: d9e3a7c1f5b2
Revises: c8d2f6a1b9e4
Create Date: 2026-11-14 19:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'd9e3a7c1f5b2'
down_revision: str | None = 'c8d2f6a1b9e4'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('canvases', sa.Column('workspace_id', sa.Uuid(), nullable=True))
    op.add_column(
        'canvases',
        sa.Column('is_channel_canvas', sa.Boolean(), server_default='false', nullable=False),
    )
    op.add_column(
        'canvases',
        sa.Column('access', sa.String(length=16), server_default='workspace', nullable=False),
    )
    op.add_column('canvases', sa.Column('emoji', sa.String(length=64), nullable=True))
    op.add_column('canvases', sa.Column('created_by', sa.Uuid(), nullable=True))
    op.add_column('canvases', sa.Column('ydoc_state', sa.LargeBinary(), nullable=True))
    op.add_column(
        'canvases', sa.Column('ydoc_size', sa.Integer(), server_default='0', nullable=False)
    )

    # Data migration: every existing canvas belonged to exactly one channel.
    op.execute(
        """
        UPDATE canvases AS cv
        SET workspace_id = ch.workspace_id,
            is_channel_canvas = true,
            access = 'channel',
            created_by = COALESCE(cv.updated_by, ch.created_by)
        FROM channels AS ch
        WHERE ch.id = cv.channel_id
        """
    )
    op.alter_column('canvases', 'workspace_id', nullable=False)
    op.alter_column('canvases', 'access', server_default=None)
    op.alter_column('canvases', 'channel_id', nullable=True)

    op.drop_constraint('canvases_channel_id_key', 'canvases', type_='unique')
    op.create_index(
        'uq_canvases_channel_canvas',
        'canvases',
        ['channel_id'],
        unique=True,
        postgresql_where=sa.text('is_channel_canvas'),
    )
    op.create_index(op.f('ix_canvases_channel_id'), 'canvases', ['channel_id'], unique=False)
    op.create_index(
        'ix_canvases_workspace_updated', 'canvases', ['workspace_id', 'updated_at'], unique=False
    )
    op.create_foreign_key(
        'canvases_workspace_id_fkey', 'canvases', 'workspaces', ['workspace_id'], ['id'],
        ondelete='CASCADE',
    )
    op.create_foreign_key(
        'canvases_created_by_fkey', 'canvases', 'users', ['created_by'], ['id'],
        ondelete='SET NULL',
    )
    op.create_check_constraint(
        'ck_canvases_access', 'canvases', "access IN ('workspace', 'private', 'channel')"
    )
    op.create_check_constraint(
        'ck_canvases_channel_access', 'canvases', "access <> 'channel' OR channel_id IS NOT NULL"
    )
    op.create_check_constraint(
        'ck_canvases_channel_canvas',
        'canvases',
        "NOT is_channel_canvas OR (channel_id IS NOT NULL AND access = 'channel')",
    )

    op.create_table(
        'canvas_members',
        sa.Column('canvas_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(['canvas_id'], ['canvases.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('canvas_id', 'user_id'),
    )
    op.create_index(
        op.f('ix_canvas_members_user_id'), 'canvas_members', ['user_id'], unique=False
    )

    op.create_table(
        'canvas_comments',
        sa.Column('canvas_id', sa.Uuid(), nullable=False),
        sa.Column('thread_id', sa.Uuid(), nullable=False),
        sa.Column('anchor_id', sa.String(length=64), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('quote', sa.Text(), nullable=True),
        sa.Column('author_id', sa.Uuid(), nullable=True),
        sa.Column('resolved', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['canvas_id'], ['canvases.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_canvas_comments_canvas_created', 'canvas_comments', ['canvas_id', 'created_at'],
        unique=False,
    )
    op.create_index(
        op.f('ix_canvas_comments_thread_id'), 'canvas_comments', ['thread_id'], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_canvas_comments_thread_id'), table_name='canvas_comments')
    op.drop_index('ix_canvas_comments_canvas_created', table_name='canvas_comments')
    op.drop_table('canvas_comments')
    op.drop_index(op.f('ix_canvas_members_user_id'), table_name='canvas_members')
    op.drop_table('canvas_members')

    # Only channel canvases existed before; standalone ones can't be represented.
    op.execute("DELETE FROM canvases WHERE NOT is_channel_canvas")
    op.drop_constraint('ck_canvases_channel_canvas', 'canvases', type_='check')
    op.drop_constraint('ck_canvases_channel_access', 'canvases', type_='check')
    op.drop_constraint('ck_canvases_access', 'canvases', type_='check')
    op.drop_constraint('canvases_created_by_fkey', 'canvases', type_='foreignkey')
    op.drop_constraint('canvases_workspace_id_fkey', 'canvases', type_='foreignkey')
    op.drop_index('ix_canvases_workspace_updated', table_name='canvases')
    op.drop_index(op.f('ix_canvases_channel_id'), table_name='canvases')
    op.drop_index('uq_canvases_channel_canvas', table_name='canvases')
    op.alter_column('canvases', 'channel_id', nullable=False)
    op.create_unique_constraint('canvases_channel_id_key', 'canvases', ['channel_id'])
    op.drop_column('canvases', 'ydoc_size')
    op.drop_column('canvases', 'ydoc_state')
    op.drop_column('canvases', 'created_by')
    op.drop_column('canvases', 'emoji')
    op.drop_column('canvases', 'access')
    op.drop_column('canvases', 'is_channel_canvas')
    op.drop_column('canvases', 'workspace_id')
