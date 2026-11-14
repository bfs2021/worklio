import re
import secrets
import unicodedata
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from app import admin
from app.api.deps import DB, CurrentUser, WorkspaceMembership, is_guest
from app.api.routes.channels import add_members, notify_joined
from app.models import (
    Channel,
    ChannelMember,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceRole,
)
from app.profiles import member_out
from app.realtime.hub import notify_user, online_user_ids, publish_to_workspace
from app.schemas import MemberInviteIn, MemberOut, PresenceOut, WorkspaceIn, WorkspaceOut

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


def slugify(name: str) -> str:
    """Workspace URL from its name, e.g. "Acme Café & Co." -> "acme-cafe-co"."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:48].strip("-")
    return slug if len(slug) >= 2 else "workspace"


async def unique_slug(db, base: str) -> str:
    taken = set(
        await db.scalars(
            select(Workspace.slug).where(
                or_(Workspace.slug == base, Workspace.slug.like(f"{base}-%"))
            )
        )
    )
    if base not in taken:
        return base
    for n in range(2, 100):
        if f"{base}-{n}" not in taken:
            return f"{base}-{n}"
    return f"{base}-{secrets.token_hex(3)}"


@router.post("", response_model=WorkspaceOut, status_code=status.HTTP_201_CREATED)
async def create_workspace(data: WorkspaceIn, db: DB, user: CurrentUser) -> Workspace:
    if data.slug is None:
        slug = await unique_slug(db, slugify(data.name))
    else:
        slug = data.slug
        if await db.scalar(select(Workspace.id).where(Workspace.slug == slug)):
            raise HTTPException(status.HTTP_409_CONFLICT, "Slug already taken")
    ws = Workspace(name=data.name, slug=slug, owner_id=user.id)
    db.add(ws)
    try:
        await db.flush()
    except IntegrityError:  # concurrent create with the same slug
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Slug already taken") from None
    general = Channel(workspace_id=ws.id, name="general", created_by=user.id)
    db.add_all([WorkspaceMember(workspace_id=ws.id, user_id=user.id, role=WorkspaceRole.owner), general])
    await db.flush()
    db.add(ChannelMember(channel_id=general.id, user_id=user.id, role=admin.MANAGER))
    await db.commit()
    return ws


@router.get("", response_model=list[WorkspaceOut])
async def list_my_workspaces(db: DB, user: CurrentUser) -> list[Workspace]:
    rows = await db.scalars(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.created_at)
    )
    return list(rows)


@router.get("/{workspace_id}", response_model=WorkspaceOut)
async def get_workspace(workspace_id: uuid.UUID, db: DB, _: WorkspaceMembership) -> Workspace:
    return await db.get(Workspace, workspace_id)


@router.get("/{workspace_id}/members", response_model=list[MemberOut])
async def list_members(
    workspace_id: uuid.UUID, db: DB, membership: WorkspaceMembership
) -> list[MemberOut]:
    hide_emails = is_guest(membership)
    rows = await db.execute(
        select(WorkspaceMember, User)
        .join(User, User.id == WorkspaceMember.user_id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(User.full_name)
    )
    return [
        member_out(u, m.role, hide_email=hide_emails and u.id != membership.user_id)
        for m, u in rows
    ]


@router.post("/{workspace_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    workspace_id: uuid.UUID,
    data: MemberInviteIn,
    db: DB,
    user: CurrentUser,
    actor: WorkspaceMembership,
) -> MemberOut:
    """Add an existing user directly (policy `invite_members`).

    Guests can only be added by admins, and admins only by owners. Invite links are the
    shareable alternative (app.api.routes.invites).
    """
    await admin.require_policy(db, actor, "invite_members")
    if data.role == WorkspaceRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot grant owner role")
    if data.role == WorkspaceRole.guest and not admin.is_admin_role(actor.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can invite guests")
    if data.role == WorkspaceRole.admin and actor.role != WorkspaceRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can add admins")
    target = await db.scalar(select(User).where(User.email == data.email.lower()))
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    exists = await db.scalar(
        select(WorkspaceMember.id).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == target.id
        )
    )
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Already a member")
    if await admin.get_deactivation(db, workspace_id, target.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "This person is deactivated; reactivate them instead")
    member = WorkspaceMember(workspace_id=workspace_id, user_id=target.id, role=data.role)
    db.add(member)
    try:
        await db.flush()
    except IntegrityError:  # concurrent add of the same person
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Already a member") from None
    # Full members land in #general and the workspace's default channels; directly added
    # guests only get #general (invite links pick a guest's channels explicitly).
    ws = await db.get(Workspace, workspace_id)
    wanted = await admin.default_channels_for_new_member(db, ws)
    if data.role == WorkspaceRole.guest:
        wanted = set(
            await db.scalars(
                select(Channel.id).where(
                    Channel.workspace_id == workspace_id, Channel.name == "general"
                )
            )
        )
    joined = {cid for cid in wanted if await add_members(db, cid, {target.id})}
    admin.record_audit(
        db, workspace_id, user.id, "member.added", "user", target.id, {"role": data.role.value}
    )
    await db.commit()
    await notify_user(target.id, {"type": "workspace.joined", "workspace_id": str(workspace_id)})
    for cid in joined:
        await notify_joined(cid, {target.id})
    await publish_to_workspace(
        workspace_id,
        {"type": "member.joined", "workspace_id": str(workspace_id), "user_id": str(target.id)},
    )
    return member_out(target, member.role)


@router.get("/{workspace_id}/presence", response_model=PresenceOut)
async def presence(workspace_id: uuid.UUID, db: DB, _: WorkspaceMembership) -> PresenceOut:
    user_ids = list(
        await db.scalars(
            select(WorkspaceMember.user_id).where(WorkspaceMember.workspace_id == workspace_id)
        )
    )
    return PresenceOut(online_user_ids=await online_user_ids(user_ids))
