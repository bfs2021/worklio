"""Workspace administration (Wave D1): settings & policies, icon, member administration and the
audit log.

Realtime events (workspace topic unless noted):
    workspace.updated {workspace_id}                       settings, policies or icon changed
    member.updated {workspace_id, user_id, role}           role changed / ownership transferred
    member.deactivated / member.reactivated / member.removed {workspace_id, user_id}
    user topic: workspace.role_changed {workspace_id, role}; session.revoked (deactivate/remove)
"""

import asyncio
import base64
import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError

from app import admin
from app.api.deps import DB, CurrentUser, WorkspaceMembership, require_workspace_admin
from app.api.routes.channels import notify_joined
from app.core import storage
from app.models import (
    AuditEvent,
    Channel,
    ChannelKind,
    DeactivatedMember,
    Message,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceRole,
)
from app.realtime.hub import notify_user, publish_to_channel, publish_to_workspace, revoke_sessions
from app.schemas_admin import (
    AdminMemberOut,
    AuditEventOut,
    AuditPageOut,
    MemberRolePatch,
    Policies,
    TransferOwnershipIn,
    WorkspaceSettingsOut,
    WorkspaceSettingsPatch,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["admin"])

AdminMembership = Annotated[WorkspaceMember, Depends(require_workspace_admin)]

MAX_ICON_BYTES = 2 * 1024 * 1024
ICON_TYPES = {
    "image/png": ("png", lambda h: h.startswith(b"\x89PNG\r\n\x1a\n")),
    "image/jpeg": ("jpg", lambda h: h.startswith(b"\xff\xd8\xff")),
    "image/gif": ("gif", lambda h: h[:6] in (b"GIF87a", b"GIF89a")),
    "image/webp": ("webp", lambda h: h[:4] == b"RIFF" and h[8:12] == b"WEBP"),
}
_EXT_TYPES = {ext: ct for ct, (ext, _) in ICON_TYPES.items()}


def icon_too_large_message() -> str:
    return f"Icon too large (max {MAX_ICON_BYTES / (1024 * 1024):g} MB)"


# --- Settings & policies --------------------------------------------------------------------


def _settings_out(ws: Workspace, viewer: WorkspaceMember) -> WorkspaceSettingsOut:
    return WorkspaceSettingsOut(
        id=ws.id,
        name=ws.name,
        slug=ws.slug,
        description=ws.description,
        icon_url=admin.icon_url(ws),
        owner_id=ws.owner_id,
        policies=Policies(**admin.policies_of(ws)),
        default_channel_ids=list(ws.default_channel_ids or []),
        viewer_role=viewer.role,
        viewer_can=admin.viewer_permissions(ws, viewer.role),
    )


async def _workspace_changed(workspace_id: uuid.UUID) -> None:
    await publish_to_workspace(
        workspace_id, {"type": "workspace.updated", "workspace_id": str(workspace_id)}
    )


@router.get("/workspaces/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
async def get_settings(
    workspace_id: uuid.UUID, db: DB, membership: WorkspaceMembership
) -> WorkspaceSettingsOut:
    """Any member may read the settings (the UI hides actions the policies forbid)."""
    ws = await db.get(Workspace, workspace_id)
    return _settings_out(ws, membership)


@router.patch("/workspaces/{workspace_id}/settings", response_model=WorkspaceSettingsOut)
async def update_settings(
    workspace_id: uuid.UUID,
    data: WorkspaceSettingsPatch,
    db: DB,
    user: CurrentUser,
    membership: AdminMembership,
) -> WorkspaceSettingsOut:
    ws = await db.get(Workspace, workspace_id, with_for_update=True)
    changed: dict[str, dict] = {}
    fields = data.model_fields_set

    if "name" in fields and data.name and data.name != ws.name:
        changed["name"] = {"from": ws.name, "to": data.name}
        ws.name = data.name
    if "slug" in fields and data.slug and data.slug != ws.slug:
        if await db.scalar(select(Workspace.id).where(Workspace.slug == data.slug)):
            raise HTTPException(status.HTTP_409_CONFLICT, "Slug already taken")
        changed["slug"] = {"from": ws.slug, "to": data.slug}
        ws.slug = data.slug
    if "description" in fields:
        desc = (data.description or "").strip() or None
        if desc != ws.description:
            changed["description"] = {"from": ws.description, "to": desc}
            ws.description = desc
    if "default_channel_ids" in fields and data.default_channel_ids is not None:
        wanted = list(dict.fromkeys(data.default_channel_ids))
        valid = set(
            await db.scalars(
                select(Channel.id).where(
                    Channel.workspace_id == workspace_id,
                    Channel.id.in_(wanted),
                    Channel.kind == ChannelKind.public,
                    Channel.is_archived.is_(False),
                )
            )
        )
        if valid != set(wanted):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Default channels must be open public channels"
            )
        if set(wanted) != set(ws.default_channel_ids or []):
            changed["default_channel_ids"] = {
                "from": [str(c) for c in ws.default_channel_ids or []],
                "to": [str(c) for c in wanted],
            }
            ws.default_channel_ids = wanted

    policy_changes: dict[str, dict] = {}
    if data.policies is not None:
        current = admin.policies_of(ws)
        updated = dict(current)
        for name, value in data.policies.model_dump(exclude_none=True).items():
            if value != current[name]:
                policy_changes[name] = {"from": current[name], "to": value}
                updated[name] = value
        if policy_changes:
            ws.policies = updated

    if not changed and not policy_changes:
        return _settings_out(ws, membership)
    if changed:
        admin.record_audit(
            db, workspace_id, user.id, "workspace.settings_updated", "workspace", workspace_id,
            {"changes": changed},
        )
    for name, change in policy_changes.items():
        admin.record_audit(
            db, workspace_id, user.id, "workspace.policy_changed", "policy", name, change
        )
    try:
        await db.commit()
    except IntegrityError:  # concurrent slug grab
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Slug already taken") from None
    await db.refresh(ws)
    await _workspace_changed(workspace_id)
    return _settings_out(ws, membership)


async def _delete_object(key: str | None) -> None:
    if not key:
        return
    try:
        await asyncio.to_thread(storage.delete, key)
    except Exception:
        log.exception("Could not delete workspace icon %s", key)


@router.post("/workspaces/{workspace_id}/icon", response_model=WorkspaceSettingsOut)
async def upload_icon(
    workspace_id: uuid.UUID, file: UploadFile, db: DB, user: CurrentUser, membership: AdminMembership
) -> WorkspaceSettingsOut:
    """Set the workspace icon (PNG, JPEG, WebP or GIF up to 2 MB)."""
    if file.size is None or file.size > MAX_ICON_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, icon_too_large_message())
    content_type = storage.normalize_content_type(file.content_type)
    kind = ICON_TYPES.get(content_type)
    head = await file.read(16)
    await file.seek(0)
    if not kind or not kind[1](head):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Use a PNG, JPEG, WebP or GIF image"
        )
    key = f"workspace-icons/{workspace_id}/{uuid.uuid4()}.{kind[0]}"
    await asyncio.to_thread(storage.upload, key, file.file, content_type)
    ws = await db.get(Workspace, workspace_id)
    old_key, ws.icon_key = ws.icon_key, key
    admin.record_audit(db, workspace_id, user.id, "workspace.icon_updated", "workspace", workspace_id)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        await _delete_object(key)
        raise
    await db.refresh(ws)
    await _delete_object(old_key)
    await _workspace_changed(workspace_id)
    return _settings_out(ws, membership)


@router.delete("/workspaces/{workspace_id}/icon", response_model=WorkspaceSettingsOut)
async def delete_icon(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, membership: AdminMembership
) -> WorkspaceSettingsOut:
    ws = await db.get(Workspace, workspace_id)
    old_key, ws.icon_key = ws.icon_key, None
    if old_key:
        admin.record_audit(
            db, workspace_id, user.id, "workspace.icon_removed", "workspace", workspace_id
        )
    await db.commit()
    await db.refresh(ws)
    await _delete_object(old_key)
    if old_key:
        await _workspace_changed(workspace_id)
    return _settings_out(ws, membership)


@router.get("/workspaces/{workspace_id}/icon", status_code=status.HTTP_302_FOUND)
async def get_icon(workspace_id: uuid.UUID, db: DB) -> RedirectResponse:
    """Unauthenticated so it works as an <img src> (also on the public invite page)."""
    ws = await db.get(Workspace, workspace_id)
    if not ws or not ws.icon_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No icon")
    ext = ws.icon_key.rsplit(".", 1)[-1]
    content_type = _EXT_TYPES.get(ext, storage.DEFAULT_CONTENT_TYPE)
    url = await asyncio.to_thread(storage.presigned_get, ws.icon_key, f"icon.{ext}", content_type)
    max_age = storage.PRESIGNED_TTL_SECONDS // 2
    return RedirectResponse(
        url, status.HTTP_302_FOUND, headers={"Cache-Control": f"private, max-age={max_age}"}
    )


# --- Members administration -----------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/admin/members", response_model=list[AdminMemberOut])
async def admin_list_members(
    workspace_id: uuid.UUID,
    db: DB,
    _: AdminMembership,
    q: Annotated[str | None, Query(max_length=100)] = None,
    role: WorkspaceRole | None = None,
    status_: Annotated[str | None, Query(alias="status", pattern="^(active|deactivated)$")] = None,
) -> list[AdminMemberOut]:
    def _filters(model):
        conds = [model.workspace_id == workspace_id]
        if role:
            conds.append(model.role == role)
        if q and q.strip():
            like = "%" + q.strip().replace("%", r"\%").replace("_", r"\_") + "%"
            conds.append(or_(User.full_name.ilike(like), User.email.ilike(like)))
        return conds

    out: list[AdminMemberOut] = []
    if status_ in (None, "active"):
        for m, u in await db.execute(
            select(WorkspaceMember, User)
            .join(User, User.id == WorkspaceMember.user_id)
            .where(*_filters(WorkspaceMember))
        ):
            out.append(
                AdminMemberOut(
                    user_id=u.id,
                    full_name=u.full_name,
                    email=None if u.is_bot else u.email,
                    avatar_url=u.avatar_url,
                    role=m.role,
                    status="active",
                    joined_at=m.created_at,
                    last_active_at=None,
                    is_bot=u.is_bot,
                )
            )
    if status_ in (None, "deactivated"):
        for d, u in await db.execute(
            select(DeactivatedMember, User)
            .join(User, User.id == DeactivatedMember.user_id)
            .where(*_filters(DeactivatedMember))
        ):
            out.append(
                AdminMemberOut(
                    user_id=u.id,
                    full_name=u.full_name,
                    email=None if u.is_bot else u.email,
                    avatar_url=u.avatar_url,
                    role=d.role,
                    status="deactivated",
                    joined_at=d.joined_at,
                    deactivated_at=d.deactivated_at,
                    last_active_at=None,
                    is_bot=u.is_bot,
                )
            )
    if out:
        # "Last active" = their latest message in this workspace.
        last = dict(
            (
                await db.execute(
                    select(Message.author_id, func.max(Message.created_at))
                    .where(
                        Message.workspace_id == workspace_id,
                        Message.author_id.in_([o.user_id for o in out]),
                    )
                    .group_by(Message.author_id)
                )
            ).all()
        )
        for o in out:
            o.last_active_at = last.get(o.user_id)
    rank = {WorkspaceRole.owner: 0, WorkspaceRole.admin: 1, WorkspaceRole.member: 2, WorkspaceRole.guest: 3}
    out.sort(key=lambda o: (o.status != "active", rank[o.role], o.full_name.lower()))
    return out


async def _target_member(db, workspace_id: uuid.UUID, user_id: uuid.UUID) -> WorkspaceMember:
    member = await db.scalar(
        select(WorkspaceMember)
        .where(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id)
        .with_for_update()
    )
    if not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    return member


async def _ensure_not_last_owner(db, workspace_id: uuid.UUID, target: WorkspaceMember) -> None:
    if target.role == WorkspaceRole.owner and await admin.owner_count(db, workspace_id) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "last_owner")


async def _ensure_not_primary_owner(db, workspace_id: uuid.UUID, user_id: uuid.UUID) -> None:
    ws = await db.get(Workspace, workspace_id)
    if ws.owner_id == user_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Transfer ownership before changing the primary owner"
        )


@router.patch("/workspaces/{workspace_id}/members/{user_id}", response_model=AdminMemberOut)
async def change_role(
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    data: MemberRolePatch,
    db: DB,
    user: CurrentUser,
    actor: WorkspaceMembership,
) -> AdminMemberOut:
    """Admins move people between member and guest; only owners grant/revoke admin or owner."""
    if user_id == user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can't change your own role")
    target = await _target_member(db, workspace_id, user_id)
    admin.check_can_manage_member(actor, target.role, user_id)
    if admin.is_admin_role(data.role) and actor.role != WorkspaceRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can manage admins and owners")
    person = await db.get(User, user_id)
    if person.is_bot:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Apps' roles can't be changed")
    old = target.role
    if data.role != old:
        if old == WorkspaceRole.owner:
            await _ensure_not_last_owner(db, workspace_id, target)
            await _ensure_not_primary_owner(db, workspace_id, user_id)
        target.role = data.role
        admin.record_audit(
            db, workspace_id, user.id, "member.role_changed", "user", user_id,
            {"from": old.value, "to": data.role.value},
        )
        await db.commit()
        event = {"workspace_id": str(workspace_id), "user_id": str(user_id), "role": data.role.value}
        await publish_to_workspace(workspace_id, {"type": "member.updated", **event})
        await notify_user(
            user_id,
            {"type": "workspace.role_changed", "workspace_id": str(workspace_id), "role": data.role.value},
        )
    return AdminMemberOut(
        user_id=person.id,
        full_name=person.full_name,
        email=person.email,
        avatar_url=person.avatar_url,
        role=target.role,
        status="active",
        joined_at=target.created_at,
        last_active_at=None,
        is_bot=person.is_bot,
    )


async def _announce_departure(
    workspace_id: uuid.UUID, user_id: uuid.UUID, channel_ids: list[uuid.UUID], kind: str
) -> None:
    for cid in channel_ids:
        await publish_to_channel(
            cid, {"type": "channel.member_left", "channel_id": str(cid), "user_id": str(user_id)}
        )
    await publish_to_workspace(
        workspace_id, {"type": kind, "workspace_id": str(workspace_id), "user_id": str(user_id)}
    )
    # Closes every socket of the person; on reconnect they no longer get this workspace's events.
    await notify_user(user_id, {"type": "workspace.access_revoked", "workspace_id": str(workspace_id)})
    await revoke_sessions(user_id)


@router.post(
    "/workspaces/{workspace_id}/members/{user_id}/deactivate",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def deactivate(
    workspace_id: uuid.UUID, user_id: uuid.UUID, db: DB, user: CurrentUser, actor: WorkspaceMembership
) -> Response:
    target = await _target_member(db, workspace_id, user_id)
    admin.check_can_manage_member(actor, target.role, user_id)
    await _ensure_not_last_owner(db, workspace_id, target)
    await _ensure_not_primary_owner(db, workspace_id, user_id)
    role = target.role
    left = await admin.deactivate_member(db, target, user.id)
    admin.record_audit(
        db, workspace_id, user.id, "member.deactivated", "user", user_id, {"role": role.value}
    )
    await db.commit()
    await _announce_departure(workspace_id, user_id, left, "member.deactivated")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/workspaces/{workspace_id}/members/{user_id}/reactivate",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def reactivate(
    workspace_id: uuid.UUID, user_id: uuid.UUID, db: DB, user: CurrentUser, actor: WorkspaceMembership
) -> Response:
    record = await db.get(DeactivatedMember, (workspace_id, user_id), with_for_update=True)
    if not record:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No deactivated member with that id")
    admin.check_can_manage_member(actor, record.role, user_id)
    role = record.role
    restored = await admin.reactivate_member(db, record)
    admin.record_audit(
        db, workspace_id, user.id, "member.reactivated", "user", user_id, {"role": role.value}
    )
    try:
        await db.commit()
    except IntegrityError:  # re-joined through an invite meanwhile
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Already an active member") from None
    await notify_user(user_id, {"type": "workspace.joined", "workspace_id": str(workspace_id)})
    for cid in restored:
        await notify_joined(cid, {user_id})
    await publish_to_workspace(
        workspace_id,
        {"type": "member.reactivated", "workspace_id": str(workspace_id), "user_id": str(user_id)},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/workspaces/{workspace_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove(
    workspace_id: uuid.UUID, user_id: uuid.UUID, db: DB, user: CurrentUser, actor: WorkspaceMembership
) -> Response:
    """Remove an active or deactivated member from the workspace."""
    target = await db.scalar(
        select(WorkspaceMember)
        .where(WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id)
        .with_for_update()
    )
    record = None if target else await db.get(DeactivatedMember, (workspace_id, user_id))
    if not target and not record:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    role = target.role if target else record.role
    admin.check_can_manage_member(actor, role, user_id)
    if target:
        await _ensure_not_last_owner(db, workspace_id, target)
        await _ensure_not_primary_owner(db, workspace_id, user_id)
    left = await admin.remove_member(db, workspace_id, user_id)
    admin.record_audit(
        db, workspace_id, user.id, "member.removed", "user", user_id,
        {"role": role.value, "was_deactivated": record is not None},
    )
    await db.commit()
    await _announce_departure(workspace_id, user_id, left, "member.removed")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/workspaces/{workspace_id}/transfer-ownership", status_code=status.HTTP_204_NO_CONTENT)
async def transfer_ownership(
    workspace_id: uuid.UUID,
    data: TransferOwnershipIn,
    db: DB,
    user: CurrentUser,
    actor: WorkspaceMembership,
) -> Response:
    """The primary owner hands the workspace to another full member and becomes an admin."""
    ws = await db.get(Workspace, workspace_id, with_for_update=True)
    if actor.role != WorkspaceRole.owner or ws.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the primary owner can transfer ownership")
    if data.user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You already own this workspace")
    target = await _target_member(db, workspace_id, data.user_id)
    person = await db.get(User, data.user_id)
    if target.role == WorkspaceRole.guest or person.is_bot or not person.is_active:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Ownership can only go to an active full member"
        )
    previous = target.role
    target.role = WorkspaceRole.owner
    ws.owner_id = data.user_id
    actor.role = WorkspaceRole.admin
    admin.record_audit(
        db, workspace_id, user.id, "workspace.ownership_transferred", "user", data.user_id,
        {"from_user_id": str(user.id), "target_previous_role": previous.value},
    )
    await db.commit()
    for uid, role in ((data.user_id, "owner"), (user.id, "admin")):
        await publish_to_workspace(
            workspace_id,
            {"type": "member.updated", "workspace_id": str(workspace_id), "user_id": str(uid), "role": role},
        )
        await notify_user(
            uid, {"type": "workspace.role_changed", "workspace_id": str(workspace_id), "role": role}
        )
    await _workspace_changed(workspace_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Audit log ------------------------------------------------------------------------------


def _encode_cursor(event: AuditEvent) -> str:
    raw = f"{event.created_at.isoformat()}|{event.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        ts, ident = raw.split("|", 1)
        return datetime.fromisoformat(ts), uuid.UUID(ident)
    except (ValueError, UnicodeDecodeError):  # binascii.Error is a ValueError
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid cursor") from None


@router.get("/workspaces/{workspace_id}/audit-log", response_model=AuditPageOut)
async def audit_log(
    workspace_id: uuid.UUID,
    db: DB,
    _: AdminMembership,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
    action: Annotated[str | None, Query(max_length=64)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> AuditPageOut:
    """Newest first. `action` matches exactly ("member.removed") or by prefix ("member.")."""
    stmt = select(AuditEvent, User.full_name).outerjoin(User, User.id == AuditEvent.actor_id).where(
        AuditEvent.workspace_id == workspace_id
    )
    if action:
        if action.endswith("."):
            escaped = action.replace("%", r"\%").replace("_", r"\_")
            stmt = stmt.where(AuditEvent.action.like(f"{escaped}%"))
        else:
            stmt = stmt.where(AuditEvent.action == action)
    if cursor:
        ts, ident = _decode_cursor(cursor)
        stmt = stmt.where(
            or_(AuditEvent.created_at < ts, (AuditEvent.created_at == ts) & (AuditEvent.id < ident))
        )
    rows = (
        await db.execute(
            stmt.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit + 1)
        )
    ).all()
    page = rows[:limit]
    # Resolve user targets server-side: the client's member cache misses deactivated
    # and just-joined people, which made the log read "a member".
    user_ids: set[uuid.UUID] = set()
    for e, _name in page:
        if e.target_type == "user" and e.target_id:
            try:
                user_ids.add(uuid.UUID(e.target_id))
            except ValueError:
                pass
    target_names: dict[str, str] = {}
    if user_ids:
        target_names = {
            str(uid): full_name
            for uid, full_name in (
                await db.execute(select(User.id, User.full_name).where(User.id.in_(user_ids)))
            ).all()
        }
    items = [
        AuditEventOut.model_validate(e).model_copy(
            update={
                "actor_name": name,
                "target_name": target_names.get(e.target_id or "") if e.target_type == "user" else None,
            }
        )
        for e, name in page
    ]
    next_cursor = _encode_cursor(rows[limit - 1][0]) if len(rows) > limit else None
    return AuditPageOut(items=items, next_cursor=next_cursor)

