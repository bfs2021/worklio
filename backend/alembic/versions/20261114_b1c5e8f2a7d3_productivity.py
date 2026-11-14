"""productivity (Wave A1): thread follows, activity read state, Later / to-dos, reminders,
channel prefs, sidebar sections and do-not-disturb

Revision ID: b1c5e8f2a7d3
Revises: c0360262d456
Create Date: 2026-11-14 12:00:00.000000

Branches from c0360262d456 in parallel with the Wave A2 messaging migration; the two heads
are merged by a separate merge revision.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'b1c5e8f2a7d3'
down_revision: str | None = 'c0360262d456'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('activity_reads',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('item_id', sa.Uuid(), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'item_id')
    )
    op.create_index(op.f('ix_activity_reads_workspace_id'), 'activity_reads', ['workspace_id'], unique=False)
    op.create_table('activity_states',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('all_read_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'workspace_id')
    )
    op.create_table('sidebar_sections',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('position', sa.Float(), nullable=False),
    sa.Column('collapsed', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_sidebar_sections_user_ws', 'sidebar_sections', ['user_id', 'workspace_id'], unique=False)
    op.create_table('channel_prefs',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('channel_id', sa.Uuid(), nullable=False),
    sa.Column('muted', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('notify', sa.String(length=16), server_default='all', nullable=False),
    sa.Column('starred', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('section_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['section_id'], ['sidebar_sections.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'channel_id')
    )
    op.create_index('ix_channel_prefs_user_ws', 'channel_prefs', ['user_id', 'workspace_id'], unique=False)
    op.create_table('activity_events',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=True),
    sa.Column('channel_id', sa.Uuid(), nullable=True),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_activity_events_user_ws_created', 'activity_events', ['user_id', 'workspace_id', 'created_at'], unique=False)
    op.create_table('saved_items',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('title', sa.String(length=500), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=16), server_default='in_progress', nullable=False),
    sa.Column('due_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('remind_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_saved_items_user_ws_status', 'saved_items', ['user_id', 'workspace_id', 'status'], unique=False)
    op.create_index('uq_saved_items_user_message', 'saved_items', ['user_id', 'message_id'], unique=True, postgresql_where=sa.text('message_id IS NOT NULL'))
    op.create_table('thread_subscriptions',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('root_id', sa.Uuid(), nullable=False),
    sa.Column('following', sa.Boolean(), nullable=True),
    sa.Column('last_read_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['root_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'root_id')
    )
    op.create_index('ix_thread_subscriptions_root', 'thread_subscriptions', ['root_id'], unique=False)
    op.create_table('reminders',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('text', sa.String(length=500), nullable=False),
    sa.Column('remind_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=True),
    sa.Column('saved_item_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['saved_item_id'], ['saved_items.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('saved_item_id')
    )
    op.create_index('ix_reminders_pending_due', 'reminders', ['remind_at'], unique=False, postgresql_where=sa.text("status = 'pending'"))
    op.create_index('ix_reminders_user_ws_status', 'reminders', ['user_id', 'workspace_id', 'status'], unique=False)
    op.add_column('users', sa.Column('dnd_until', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('users', 'dnd_until')
    op.drop_index('ix_reminders_user_ws_status', table_name='reminders')
    op.drop_index('ix_reminders_pending_due', table_name='reminders', postgresql_where=sa.text("status = 'pending'"))
    op.drop_table('reminders')
    op.drop_index('ix_thread_subscriptions_root', table_name='thread_subscriptions')
    op.drop_table('thread_subscriptions')
    op.drop_index('uq_saved_items_user_message', table_name='saved_items', postgresql_where=sa.text('message_id IS NOT NULL'))
    op.drop_index('ix_saved_items_user_ws_status', table_name='saved_items')
    op.drop_table('saved_items')
    op.drop_index('ix_activity_events_user_ws_created', table_name='activity_events')
    op.drop_table('activity_events')
    op.drop_index('ix_channel_prefs_user_ws', table_name='channel_prefs')
    op.drop_table('channel_prefs')
    op.drop_index('ix_sidebar_sections_user_ws', table_name='sidebar_sections')
    op.drop_table('sidebar_sections')
    op.drop_table('activity_states')
    op.drop_index(op.f('ix_activity_reads_workspace_id'), table_name='activity_reads')
    op.drop_table('activity_reads')
