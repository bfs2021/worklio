"""messaging extras (Wave A2): pins, bookmarks, forwards, edit history, scheduled
messages, polls, link previews and user groups

Revision ID: a2b7c4d9e1f0
Revises: b1c5e8f2a7d3
Create Date: 2026-11-14 11:31:10.278581
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'a2b7c4d9e1f0'
down_revision: str | None = 'b1c5e8f2a7d3'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('link_previews',
    sa.Column('url_hash', sa.String(length=64), nullable=False),
    sa.Column('url', sa.Text(), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('fetched_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('url_hash')
    )
    op.create_table('user_groups',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('handle', sa.String(length=40), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('workspace_id', 'handle')
    )
    op.create_index(op.f('ix_user_groups_workspace_id'), 'user_groups', ['workspace_id'], unique=False)
    op.create_table('channel_bookmarks',
    sa.Column('channel_id', sa.Uuid(), nullable=False),
    sa.Column('title', sa.String(length=100), nullable=False),
    sa.Column('url', sa.String(length=2048), nullable=False),
    sa.Column('emoji', sa.String(length=32), nullable=True),
    sa.Column('position', sa.Float(), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_channel_bookmarks_channel_position', 'channel_bookmarks', ['channel_id', 'position'], unique=False)
    op.create_table('user_group_members',
    sa.Column('group_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['user_groups.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('group_id', 'user_id')
    )
    op.create_index(op.f('ix_user_group_members_user_id'), 'user_group_members', ['user_id'], unique=False)
    op.create_table('message_edits',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('edited_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_message_edits_message_edited', 'message_edits', ['message_id', 'edited_at'], unique=False)
    op.create_table('message_forwards',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('source_message_id', sa.Uuid(), nullable=True),
    sa.Column('source_channel_id', sa.UUID(), nullable=False),
    sa.Column('source_author_id', sa.UUID(), nullable=False),
    sa.Column('source_created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('body_preview', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['source_message_id'], ['messages.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('message_id')
    )
    op.create_index(op.f('ix_message_forwards_source_message_id'), 'message_forwards', ['source_message_id'], unique=False)
    op.create_table('message_pins',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('channel_id', sa.Uuid(), nullable=False),
    sa.Column('pinned_by', sa.Uuid(), nullable=True),
    sa.Column('pinned_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['pinned_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('message_id')
    )
    op.create_index('ix_message_pins_channel_pinned', 'message_pins', ['channel_id', 'pinned_at'], unique=False)
    op.create_table('message_unfurls',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('urls', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('items', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('hidden_urls', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('message_id')
    )
    op.create_table('polls',
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('channel_id', sa.Uuid(), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('question', sa.String(length=300), nullable=False),
    sa.Column('multiple', sa.Boolean(), nullable=False),
    sa.Column('anonymous', sa.Boolean(), nullable=False),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('message_id')
    )
    op.create_table('scheduled_messages',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('channel_id', sa.Uuid(), nullable=False),
    sa.Column('author_id', sa.Uuid(), nullable=False),
    sa.Column('parent_id', sa.Uuid(), nullable=True),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('attachment_ids', postgresql.ARRAY(sa.UUID()), server_default='{}', nullable=False),
    sa.Column('send_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
    sa.Column('error', sa.String(length=200), nullable=True),
    sa.Column('sent_message_id', sa.Uuid(), nullable=True),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['channel_id'], ['channels.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['parent_id'], ['messages.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['sent_message_id'], ['messages.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_scheduled_messages_author_ws', 'scheduled_messages', ['author_id', 'workspace_id'], unique=False)
    op.create_index('ix_scheduled_messages_due', 'scheduled_messages', ['send_at'], unique=False, postgresql_where=sa.text("status = 'pending'"))
    op.create_table('poll_options',
    sa.Column('poll_id', sa.Uuid(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('text', sa.String(length=140), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['poll_id'], ['polls.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_poll_options_poll_position', 'poll_options', ['poll_id', 'position'], unique=False)
    op.create_table('poll_votes',
    sa.Column('poll_id', sa.Uuid(), nullable=False),
    sa.Column('option_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['option_id'], ['poll_options.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['poll_id'], ['polls.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('option_id', 'user_id')
    )
    op.create_index('ix_poll_votes_poll_user', 'poll_votes', ['poll_id', 'user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_poll_votes_poll_user', table_name='poll_votes')
    op.drop_table('poll_votes')
    op.drop_index('ix_poll_options_poll_position', table_name='poll_options')
    op.drop_table('poll_options')
    op.drop_index('ix_scheduled_messages_due', table_name='scheduled_messages', postgresql_where=sa.text("status = 'pending'"))
    op.drop_index('ix_scheduled_messages_author_ws', table_name='scheduled_messages')
    op.drop_table('scheduled_messages')
    op.drop_table('polls')
    op.drop_table('message_unfurls')
    op.drop_index('ix_message_pins_channel_pinned', table_name='message_pins')
    op.drop_table('message_pins')
    op.drop_index(op.f('ix_message_forwards_source_message_id'), table_name='message_forwards')
    op.drop_table('message_forwards')
    op.drop_index('ix_message_edits_message_edited', table_name='message_edits')
    op.drop_table('message_edits')
    op.drop_index(op.f('ix_user_group_members_user_id'), table_name='user_group_members')
    op.drop_table('user_group_members')
    op.drop_index('ix_channel_bookmarks_channel_position', table_name='channel_bookmarks')
    op.drop_table('channel_bookmarks')
    op.drop_index(op.f('ix_user_groups_workspace_id'), table_name='user_groups')
    op.drop_table('user_groups')
    op.drop_table('link_previews')
