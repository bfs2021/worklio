"""Workspace administration (Wave D1): settings/policies, deactivations, invite links,
audit log and channel managers

Revision ID: a7d1e4c2b8f3
Revises: d9e3a7c1f5b2
Create Date: 2026-11-14 21:00:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = 'a7d1e4c2b8f3'
down_revision: str | None = 'd9e3a7c1f5b2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('workspaces', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('workspaces', sa.Column('icon_key', sa.String(length=1024), nullable=True))
    op.add_column(
        'workspaces',
        sa.Column(
            'policies',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default='{}',
            nullable=False,
        ),
    )
    op.add_column(
        'workspaces',
        sa.Column(
            'default_channel_ids',
            postgresql.ARRAY(sa.UUID()),
            server_default='{}',
            nullable=False,
        ),
    )
    op.add_column(
        'channel_members',
        sa.Column('role', sa.String(length=16), server_default='member', nullable=False),
    )
    # Channel creators become managers of their (non-DM) channels.
    op.execute(
        """
        UPDATE channel_members AS cm SET role = 'manager'
        FROM channels AS c
        WHERE c.id = cm.channel_id AND c.created_by = cm.user_id AND c.kind != 'dm'
        """
    )

    op.create_table('workspace_member_deactivations',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column(
        'role',
        postgresql.ENUM('owner', 'admin', 'member', 'guest', name='workspace_role', create_type=False),
        nullable=False,
    ),
    sa.Column('joined_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('deactivated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('deactivated_by', sa.Uuid(), nullable=True),
    sa.Column('channel_memberships', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False),
    sa.ForeignKeyConstraint(['deactivated_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('workspace_id', 'user_id')
    )
    op.create_index(
        op.f('ix_workspace_member_deactivations_user_id'),
        'workspace_member_deactivations',
        ['user_id'],
        unique=False,
    )

    op.create_table('invite_links',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('channel_ids', postgresql.ARRAY(sa.UUID()), server_default='{}', nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('max_uses', sa.Integer(), nullable=True),
    sa.Column('uses', sa.Integer(), server_default='0', nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('revoked', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token')
    )
    op.create_index(
        'ix_invite_links_workspace_created', 'invite_links', ['workspace_id', 'created_at'], unique=False
    )

    op.create_table('audit_events',
    sa.Column('workspace_id', sa.Uuid(), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=True),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('target_type', sa.String(length=32), nullable=True),
    sa.Column('target_id', sa.String(length=64), nullable=True),
    sa.Column('meta', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['actor_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        'ix_audit_events_workspace_action', 'audit_events', ['workspace_id', 'action'], unique=False
    )
    op.create_index(
        'ix_audit_events_workspace_created',
        'audit_events',
        ['workspace_id', 'created_at', 'id'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_audit_events_workspace_created', table_name='audit_events')
    op.drop_index('ix_audit_events_workspace_action', table_name='audit_events')
    op.drop_table('audit_events')
    op.drop_index('ix_invite_links_workspace_created', table_name='invite_links')
    op.drop_table('invite_links')
    op.drop_index(
        op.f('ix_workspace_member_deactivations_user_id'),
        table_name='workspace_member_deactivations',
    )
    op.drop_table('workspace_member_deactivations')
    op.drop_column('channel_members', 'role')
    op.drop_column('workspaces', 'default_channel_ids')
    op.drop_column('workspaces', 'policies')
    op.drop_column('workspaces', 'icon_key')
    op.drop_column('workspaces', 'description')
