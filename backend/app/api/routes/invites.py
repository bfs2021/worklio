"""Invite links (Wave D1): shareable join links with role, expiry, use limits and, for guests,
the channels they may see.

    GET/POST /workspaces/{id}/invite-links, DELETE /invite-links/{id}   (manage)
    GET /invites/{token}                                                 (public preview)
    POST /invites/{token}/accept                                         (signed in)
"""

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app import admin
from app.api.deps import DB, CurrentUser, WorkspaceMembership
from app.api.routes.channels import add_members, notify_joined
from app.models import (
    Channel,
    ChannelKind,
    ChannelMember,
    InviteLink,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceRole,
)
from app.realtime.hub import notify_user, publish_to_workspace
from app.schemas_admin import (
    InviteAcceptOut,
    InviteLinkIn,
    InviteLinkOut,
    InvitePreviewOut,
)

router = APIRouter(tags=["invites"])

MAX_ACTIVE_LINKS_PER_WORKSPACE = 200


def invalid_reason(link: InviteLink, now: datetime | None = None) -> str | None:
    now = now or datetime.now(UTC)
    if link.revoked:
        return "revoked"
    if link.expires_at and link.expires_at <= now:
        return "expired"
    if link.max_uses is not None and link.uses >= link.max_uses:
        return "used_up"
    return None


def _out(link: InviteLink) -> InviteLinkOut:
    out = InviteLinkOut.model_validate(link)
    out.valid = invalid_reason(link) is None
    return out


@router.get("/workspaces/{workspace_id}/invite-links", response_model=list[InviteLinkOut])
async def list_links(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, membership: WorkspaceMembership
) -> list[InviteLinkOut]:
    """Admins see every link; members allowed to invite see the links they created."""
    await admin.require_policy(db, membership, "invite_members")
    stmt = select(InviteLink).where(InviteLink.workspace_id == workspace_id)
    if not admin.is_admin_role(membership.role):
        stmt = stmt.where(InviteLink.created_by == user.id)
    links = await db.scalars(stmt.order_by(InviteLink.created_at.desc()).limit(200))
    return [_out(link) for link in links]


@router.post(
    "/workspaces/{workspace_id}/invite-links",
    response_model=InviteLinkOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_link(
    workspace_id: uuid.UUID,
    data: InviteLinkIn,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
) -> InviteLinkOut:
    await admin.require_policy(db, membership, "invite_members")
    if data.role == "guest" and not admin.is_admin_role(membership.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can invite guests")
    if data.channel_ids:
        rows = list(
            await db.scalars(
                select(Channel).where(
                    Channel.workspace_id == workspace_id, Channel.id.in_(data.channel_ids)
                )
            )
        )
        if len(rows) != len(data.channel_ids) or any(
            c.kind == ChannelKind.dm or c.is_archived for c in rows
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Invite channels must be open channels in this workspace"
            )
        private = [c.id for c in rows if c.kind == ChannelKind.private]
        if private:
            mine = set(
                await db.scalars(
                    select(ChannelMember.channel_id).where(
                        ChannelMember.user_id == user.id, ChannelMember.channel_id.in_(private)
                    )
                )
            )
            if mine != set(private):
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "You can only invite people to private channels you're in"
                )
    active = await db.scalar(
        select(InviteLink.id)
        .where(InviteLink.workspace_id == workspace_id, InviteLink.revoked.is_(False))
        .offset(MAX_ACTIVE_LINKS_PER_WORKSPACE - 1)
        .limit(1)
    )
    if active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many invite links; revoke some first")
    link = InviteLink(
        id=uuid.uuid4(),
        workspace_id=workspace_id,
        token=secrets.token_urlsafe(24),
        role=data.role,
        channel_ids=data.channel_ids,
        expires_at=(
            datetime.now(UTC) + timedelta(hours=data.expires_in_hours)
            if data.expires_in_hours
            else None
        ),
        max_uses=data.max_uses,
        uses=0,
        created_by=user.id,
        revoked=False,
    )
    db.add(link)
    admin.record_audit(
        db, workspace_id, user.id, "invite_link.created", "invite_link", link.id,
        {
            "role": data.role,
            "channel_ids": [str(c) for c in data.channel_ids],
            "expires_at": link.expires_at.isoformat() if link.expires_at else None,
            "max_uses": data.max_uses,
        },
    )
    await db.commit()
    await db.refresh(link)
    return _out(link)


@router.delete("/invite-links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_link(link_id: uuid.UUID, db: DB, user: CurrentUser) -> Response:
    link = await db.get(InviteLink, link_id, with_for_update=True)
    member = (
        await db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == link.workspace_id, WorkspaceMember.user_id == user.id
            )
        )
        if link
        else None
    )
    if not link or not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite link not found")
    if not admin.is_admin_role(member.role) and link.created_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins or the link's creator can revoke it")
    if not link.revoked:
        link.revoked = True
        admin.record_audit(
            db, link.workspace_id, user.id, "invite_link.revoked", "invite_link", link.id,
            {"role": link.role, "uses": link.uses},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/invites/{token}", response_model=InvitePreviewOut)
async def preview_invite(token: str, db: DB) -> InvitePreviewOut:
    """Public (no auth): what the invite page shows before someone signs in."""
    link = await db.scalar(select(InviteLink).where(InviteLink.token == token[:64]))
    if not link:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")
    ws = await db.get(Workspace, link.workspace_id)
    inviter = await db.get(User, link.created_by) if link.created_by else None
    reason = invalid_reason(link)
    return InvitePreviewOut(
        workspace_name=ws.name,
        workspace_icon_url=admin.icon_url(ws),
        inviter_name=inviter.full_name if inviter else None,
        role=link.role,
        valid=reason is None,
        reason=reason,
    )


@router.post("/invites/{token}/accept", response_model=InviteAcceptOut)
async def accept_invite(token: str, db: DB, user: CurrentUser) -> InviteAcceptOut:
    link = await db.scalar(
        select(InviteLink).where(InviteLink.token == token[:64]).with_for_update()
    )
    if not link:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")
    workspace_id = link.workspace_id
    if user.is_bot:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apps can't accept invites")
    existing = await db.scalar(
        select(WorkspaceMember.id).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user.id
        )
    )
    if existing:
        return InviteAcceptOut(workspace_id=workspace_id, already_member=True)
    if await admin.get_deactivation(db, workspace_id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "account_deactivated")
    reason = invalid_reason(link)
    if reason:
        raise HTTPException(status.HTTP_410_GONE, f"invite_{reason}")

    ws = await db.get(Workspace, workspace_id)
    role = WorkspaceRole.guest if link.role == "guest" else WorkspaceRole.member
    db.add(WorkspaceMember(workspace_id=workspace_id, user_id=user.id, role=role))
    await db.flush()
    channel_ids: set[uuid.UUID] = set()
    if link.channel_ids:
        channel_ids |= set(
            await db.scalars(
                select(Channel.id).where(
                    Channel.workspace_id == workspace_id,
                    Channel.id.in_(link.channel_ids),
                    Channel.kind != ChannelKind.dm,
                    Channel.is_archived.is_(False),
                )
            )
        )
    if role == WorkspaceRole.member:
        channel_ids |= await admin.default_channels_for_new_member(db, ws)
    added = {cid for cid in channel_ids if await add_members(db, cid, {user.id})}
    link.uses += 1
    admin.record_audit(
        db, workspace_id, user.id, "member.joined_via_invite", "user", user.id,
        {"invite_link_id": str(link.id), "role": role.value},
    )
    await db.commit()
    await notify_user(user.id, {"type": "workspace.joined", "workspace_id": str(workspace_id)})
    for cid in added:
        await notify_joined(cid, {user.id})
    await publish_to_workspace(
        workspace_id,
        {"type": "member.joined", "workspace_id": str(workspace_id), "user_id": str(user.id)},
    )
    return InviteAcceptOut(workspace_id=workspace_id)
