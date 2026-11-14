"""Auth + tenant-isolation dependencies.

Every workspace/channel-scoped route must go through one of the `require_*`
dependencies so membership is checked in exactly one place.
"""

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.security import decode_access_token
from app.models import (
    Channel,
    ChannelKind,
    ChannelMember,
    DeactivatedMember,
    User,
    WorkspaceMember,
    WorkspaceRole,
)

DB = Annotated[AsyncSession, Depends(get_db)]
_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    db: DB, creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> User:
    user_id = decode_access_token(creds.credentials) if creds else None
    user = await db.get(User, user_id) if user_id else None
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_workspace_membership(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> WorkspaceMember | None:
    return await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )


async def require_workspace_member(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser
) -> WorkspaceMember:
    member = await get_workspace_membership(db, workspace_id, user.id)
    if not member:
        # Deactivated people know the workspace exists; tell them why they're locked out.
        if await db.get(DeactivatedMember, (workspace_id, user.id)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "account_deactivated")
        # 404 rather than 403 so we don't leak which workspaces exist.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    return member


WorkspaceMembership = Annotated[WorkspaceMember, Depends(require_workspace_member)]


def require_workspace_admin(member: WorkspaceMembership) -> WorkspaceMember:
    if member.role not in (WorkspaceRole.owner, WorkspaceRole.admin):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin role required")
    return member


def is_guest(member: WorkspaceMember) -> bool:
    return member.role == WorkspaceRole.guest


def require_full_member(member: WorkspaceMembership) -> WorkspaceMember:
    """Owners, admins and members. Guests only see channels they were explicitly added to."""
    if is_guest(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Guests can't do that")
    return member


FullMembership = Annotated[WorkspaceMember, Depends(require_full_member)]


async def is_channel_member(db: AsyncSession, channel_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return bool(
        await db.scalar(
            select(ChannelMember.id).where(
                ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id
            )
        )
    )


async def require_channel_access(channel_id: uuid.UUID, db: DB, user: CurrentUser) -> Channel:
    """User must belong to the channel's workspace; private/DM channels also need membership.

    Guests are treated as if every channel were private: they need explicit membership.
    """
    channel = await db.get(Channel, channel_id)
    ws_member = await get_workspace_membership(db, channel.workspace_id, user.id) if channel else None
    if not channel or not ws_member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Channel not found")
    needs_membership = channel.kind != ChannelKind.public or is_guest(ws_member)
    if needs_membership and not await is_channel_member(db, channel.id, user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Channel not found")
    return channel


ChannelAccess = Annotated[Channel, Depends(require_channel_access)]


def ensure_not_archived(channel: Channel) -> None:
    if channel.is_archived:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This channel is archived")


def readable_channel_ids(workspace_id: uuid.UUID, user_id: uuid.UUID, guest: bool):
    """Subquery of channel ids the user may read in a workspace (search, mentions)."""
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
    visible = Channel.id.in_(mine) if guest else or_(Channel.kind == ChannelKind.public, Channel.id.in_(mine))
    return select(Channel.id).where(Channel.workspace_id == workspace_id, visible)
