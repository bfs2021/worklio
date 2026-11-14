"""Workspace administration services (Wave D1): policies, audit log, member lifecycle,
channel managers.

Other modules gate actions with `require_policy` / `policy_allows`:

    await require_policy(db, membership, "use_ai")   # 403 {"detail": "policy:use_ai"}

and record admin actions with `record_audit` (never put secrets such as API keys in `meta`).
"""

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import (
    AuditEvent,
    Channel,
    ChannelKind,
    ChannelMember,
    DeactivatedMember,
    UserGroup,
    UserGroupMember,
    Workspace,
    WorkspaceMember,
    WorkspaceRole,
)

PolicyName = Literal[
    "create_public_channels",
    "create_private_channels",
    "invite_members",
    "create_user_groups",
    "start_huddles",
    "use_ai",
    "install_apps",
    "archive_channels",
]

DEFAULT_POLICIES: dict[str, str] = {
    "create_public_channels": "everyone",
    "create_private_channels": "everyone",
    "invite_members": "admins",
    "create_user_groups": "everyone",
    "start_huddles": "everyone",
    "use_ai": "everyone",
    "install_apps": "everyone",
    "archive_channels": "everyone",
}
POLICY_NAMES: tuple[str, ...] = tuple(DEFAULT_POLICIES)

ADMIN_ROLES = (WorkspaceRole.owner, WorkspaceRole.admin)
MANAGER = "manager"
MEMBER = "member"


def is_admin_role(role: WorkspaceRole | str | None) -> bool:
    return role in ADMIN_ROLES


# --- Policies -------------------------------------------------------------------------------


def policies_of(ws: Workspace) -> dict[str, str]:
    stored = ws.policies or {}
    return {
        name: stored.get(name) if stored.get(name) in ("everyone", "admins") else default
        for name, default in DEFAULT_POLICIES.items()
    }


def role_allows(policies: dict[str, str], role: WorkspaceRole | str, name: str) -> bool:
    """Guests never pass a policy; owners/admins always do; members only when "everyone"."""
    if name not in DEFAULT_POLICIES:
        raise ValueError(f"Unknown policy {name!r}")
    if role == WorkspaceRole.guest:
        return False
    if is_admin_role(role):
        return True
    return policies.get(name, DEFAULT_POLICIES[name]) == "everyone"


async def policy_allows(db: AsyncSession, member: WorkspaceMember, name: str) -> bool:
    ws = await db.get(Workspace, member.workspace_id)
    return bool(ws) and role_allows(policies_of(ws), member.role, name)


async def require_policy(db: AsyncSession, member: WorkspaceMember, name: str) -> None:
    """Raise 403 {"detail": "policy:<name>"} unless the member may do `name`."""
    if not await policy_allows(db, member, name):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"policy:{name}")


async def require_policy_for(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, name: str
) -> WorkspaceMember:
    """`require_policy` for code that only has ids (e.g. channel-scoped routes)."""
    member = await db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    await require_policy(db, member, name)
    return member


def viewer_permissions(ws: Workspace, role: WorkspaceRole) -> dict[str, bool]:
    policies = policies_of(ws)
    return {name: role_allows(policies, role, name) for name in POLICY_NAMES}


def icon_url(ws: Workspace) -> str | None:
    """Absolute, cache-busting URL of the icon (served by GET /workspaces/{id}/icon)."""
    if not ws.icon_key:
        return None
    version = int(ws.updated_at.timestamp()) if ws.updated_at else 0
    return f"{settings.api_public_url.rstrip('/')}/workspaces/{ws.id}/icon?v={version}"


# --- Audit log ------------------------------------------------------------------------------


def record_audit(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str | None = None,
    target_id: uuid.UUID | str | None = None,
    meta: dict | None = None,
) -> AuditEvent:
    """Add an audit event to the session (committed with the caller's change).

    Never pass secrets (API keys, tokens) in `meta`.
    """
    event = AuditEvent(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        meta=meta or {},
        created_at=datetime.now(UTC),
    )
    db.add(event)
    return event


# --- Members --------------------------------------------------------------------------------


async def owner_count(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    return await db.scalar(
        select(func.count())
        .select_from(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.role == WorkspaceRole.owner,
        )
    )


async def get_deactivation(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> DeactivatedMember | None:
    return await db.get(DeactivatedMember, (workspace_id, user_id))


def check_can_manage_member(
    actor: WorkspaceMember, target_role: WorkspaceRole, target_user_id: uuid.UUID
) -> None:
    """Admins manage members and guests; only owners manage admins and owners."""
    if not is_admin_role(actor.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin role required")
    if target_user_id == actor.user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can't do that to yourself")
    if is_admin_role(target_role) and actor.role != WorkspaceRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can manage admins and owners")


async def workspace_channel_ids(db: AsyncSession, workspace_id: uuid.UUID) -> list[uuid.UUID]:
    return list(await db.scalars(select(Channel.id).where(Channel.workspace_id == workspace_id)))


async def detach_channel_memberships(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> list[dict]:
    """Delete the user's channel memberships in the workspace; returns what was removed."""
    rows = (
        await db.execute(
            delete(ChannelMember)
            .where(
                ChannelMember.user_id == user_id,
                ChannelMember.channel_id.in_(
                    select(Channel.id).where(Channel.workspace_id == workspace_id)
                ),
            )
            .returning(ChannelMember.channel_id, ChannelMember.role, ChannelMember.last_read_at)
        )
    ).all()
    return [
        {"channel_id": str(cid), "role": role or MEMBER, "last_read_at": read.isoformat()}
        for cid, role, read in rows
    ]


async def deactivate_member(
    db: AsyncSession, member: WorkspaceMember, actor_id: uuid.UUID
) -> list[uuid.UUID]:
    """Move a member into `workspace_member_deactivations`; returns the channels they left."""
    memberships = await detach_channel_memberships(db, member.workspace_id, member.user_id)
    db.add(
        DeactivatedMember(
            workspace_id=member.workspace_id,
            user_id=member.user_id,
            role=member.role,
            joined_at=member.created_at,
            deactivated_at=datetime.now(UTC),
            deactivated_by=actor_id,
            channel_memberships=memberships,
        )
    )
    await db.delete(member)
    return [uuid.UUID(m["channel_id"]) for m in memberships]


async def reactivate_member(db: AsyncSession, record: DeactivatedMember) -> list[uuid.UUID]:
    """Restore the membership and the channels that still exist; returns restored channel ids."""
    db.add(
        WorkspaceMember(
            workspace_id=record.workspace_id,
            user_id=record.user_id,
            role=record.role,
            created_at=record.joined_at,
        )
    )
    wanted = {uuid.UUID(m["channel_id"]): m for m in record.channel_memberships or []}
    existing = (
        set(
            await db.scalars(
                select(Channel.id).where(
                    Channel.workspace_id == record.workspace_id, Channel.id.in_(wanted)
                )
            )
        )
        if wanted
        else set()
    )
    restored: list[uuid.UUID] = []
    for cid in existing:
        m = wanted[cid]
        added = await db.scalar(
            pg_insert(ChannelMember)
            .values(
                id=uuid.uuid4(),
                channel_id=cid,
                user_id=record.user_id,
                role=m.get("role") or MEMBER,
                last_read_at=datetime.fromisoformat(m["last_read_at"]),
            )
            .on_conflict_do_nothing(index_elements=["channel_id", "user_id"])
            .returning(ChannelMember.channel_id)
        )
        if added:
            restored.append(added)
    await db.delete(record)
    return restored


async def remove_member(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> list[uuid.UUID]:
    """Remove someone from the workspace for good (active or deactivated)."""
    left = [
        uuid.UUID(m["channel_id"])
        for m in await detach_channel_memberships(db, workspace_id, user_id)
    ]
    await db.execute(
        delete(UserGroupMember).where(
            UserGroupMember.user_id == user_id,
            UserGroupMember.group_id.in_(
                select(UserGroup.id).where(UserGroup.workspace_id == workspace_id)
            ),
        )
    )
    await db.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    await db.execute(
        delete(DeactivatedMember).where(
            DeactivatedMember.workspace_id == workspace_id, DeactivatedMember.user_id == user_id
        )
    )
    return left


async def deactivated_dm_members(
    db: AsyncSession, workspace_id: uuid.UUID, dm_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Deactivated people who were in these DMs, so conversations with them still render."""
    if not dm_ids:
        return {}
    wanted = {str(c) for c in dm_ids}
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for user_id, memberships in await db.execute(
        select(DeactivatedMember.user_id, DeactivatedMember.channel_memberships).where(
            DeactivatedMember.workspace_id == workspace_id
        )
    ):
        for m in memberships or []:
            if m.get("channel_id") in wanted:
                out.setdefault(uuid.UUID(m["channel_id"]), []).append(user_id)
    return out


async def default_channels_for_new_member(
    db: AsyncSession, ws: Workspace
) -> set[uuid.UUID]:
    """#general plus the workspace's default channels that are still public and open."""
    general = await db.scalar(
        select(Channel.id).where(Channel.workspace_id == ws.id, Channel.name == "general")
    )
    ids = {general} if general else set()
    if ws.default_channel_ids:
        ids |= set(
            await db.scalars(
                select(Channel.id).where(
                    Channel.workspace_id == ws.id,
                    Channel.id.in_(ws.default_channel_ids),
                    Channel.kind == ChannelKind.public,
                    Channel.is_archived.is_(False),
                )
            )
        )
    return ids


# --- Channel managers -----------------------------------------------------------------------


async def channel_role(db: AsyncSession, channel_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
    return await db.scalar(
        select(ChannelMember.role).where(
            ChannelMember.channel_id == channel_id, ChannelMember.user_id == user_id
        )
    )


async def can_manage_channel(
    db: AsyncSession, channel: Channel, member: WorkspaceMember | None
) -> bool:
    """Workspace owners/admins, or the channel's managers (never in DMs)."""
    if channel.kind == ChannelKind.dm or member is None or member.role == WorkspaceRole.guest:
        return False
    if is_admin_role(member.role):
        return True
    return await channel_role(db, channel.id, member.user_id) == MANAGER


async def manager_ids(db: AsyncSession, channel_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(ChannelMember.user_id).where(
                ChannelMember.channel_id == channel_id, ChannelMember.role == MANAGER
            )
        )
    )
