import asyncio
import hashlib
import uuid
from collections import defaultdict

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from app import admin, productivity
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    FullMembership,
    WorkspaceMembership,
    ensure_not_archived,
    get_workspace_membership,
    is_channel_member,
    is_guest,
)
from app.core import storage
from app.messaging_extras import publish_read_state
from app.models import (
    Attachment,
    Channel,
    ChannelKind,
    ChannelMember,
    Message,
    User,
    WorkspaceMember,
    WorkspaceRole,
)
from app.realtime.hub import notify_user, publish_to_channel, publish_to_workspace
from app.schemas import (
    DM_NAME_PREFIX,
    ChannelFileOut,
    ChannelIn,
    ChannelMemberIn,
    ChannelOut,
    DMIn,
)
from app.schemas_admin import ChannelMemberRolePatch, ChannelPatchIn, ChannelRolesOut

router = APIRouter(tags=["channels"])


async def _assert_workspace_members(db, workspace_id: uuid.UUID, user_ids: set[uuid.UUID]) -> None:
    found = set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id.in_(user_ids)
            )
        )
    )
    if found != user_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "All users must be workspace members")


async def add_members(db, channel_id: uuid.UUID, user_ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """Adds missing members; returns the ids that were newly added (caller notifies after commit).

    `ON CONFLICT DO NOTHING` makes concurrent joins of the same user safe (no 500s).
    """
    if not user_ids:
        return set()
    stmt = (
        pg_insert(ChannelMember)
        .values([{"id": uuid.uuid4(), "channel_id": channel_id, "user_id": u} for u in user_ids])
        .on_conflict_do_nothing(index_elements=["channel_id", "user_id"])
        .returning(ChannelMember.user_id)
    )
    return set(await db.scalars(stmt))


async def notify_joined(channel_id: uuid.UUID, user_ids: set[uuid.UUID]) -> None:
    """Subscribe the users' sockets to the channel and tell the channel who arrived."""
    for uid in user_ids:
        await notify_user(uid, {"type": "channel.joined", "channel_id": str(channel_id)})
        await publish_to_channel(
            channel_id,
            {"type": "channel.member_joined", "channel_id": str(channel_id), "user_id": str(uid)},
        )


async def _member_ids(db, channel_id: uuid.UUID) -> list[uuid.UUID]:
    return list(await db.scalars(select(ChannelMember.user_id).where(ChannelMember.channel_id == channel_id)))


async def _require_full_member_of(db, channel: Channel, user_id: uuid.UUID) -> None:
    member = await get_workspace_membership(db, channel.workspace_id, user_id)
    if not member or is_guest(member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Guests can't do that")


@router.get("/workspaces/{workspace_id}/channels", response_model=list[ChannelOut])
async def list_channels(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, membership: WorkspaceMembership
) -> list[ChannelOut]:
    """Public channels + private channels/DMs the user belongs to, with unread counts.

    Guests only see the channels they were added to.
    """
    mine = select(ChannelMember.channel_id).where(ChannelMember.user_id == user.id)
    visible = (
        Channel.id.in_(mine)
        if is_guest(membership)
        else or_(Channel.kind == ChannelKind.public, Channel.id.in_(mine))
    )
    channels = list(
        await db.scalars(
            select(Channel).where(Channel.workspace_id == workspace_id, visible).order_by(Channel.name)
        )
    )
    my_roles: dict[uuid.UUID, str] = dict(
        (
            await db.execute(
                select(ChannelMember.channel_id, ChannelMember.role).where(
                    ChannelMember.user_id == user.id
                )
            )
        ).all()
    )
    member_of = set(my_roles)

    unread = dict(
        (
            await db.execute(
                select(Message.channel_id, func.count())
                .join(
                    ChannelMember,
                    and_(
                        ChannelMember.channel_id == Message.channel_id,
                        ChannelMember.user_id == user.id,
                    ),
                )
                .where(
                    Message.workspace_id == workspace_id,
                    Message.created_at > ChannelMember.last_read_at,
                    Message.parent_id.is_(None),
                    Message.deleted_at.is_(None),
                    Message.author_id != user.id,
                    # System messages don't count, except a missed call card (DM calls only
                    # end as "missed"), so the callee sees a badge for the call they missed.
                    or_(
                        Message.kind == "user",
                        and_(
                            Message.meta["type"].astext == "call",
                            Message.meta["status"].astext == "missed",
                        ),
                    ),
                )
                .group_by(Message.channel_id)
            )
        ).all()
    )

    dm_ids = [c.id for c in channels if c.kind == ChannelKind.dm]
    dm_members: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    if dm_ids:
        for cid, uid in await db.execute(
            select(ChannelMember.channel_id, ChannelMember.user_id).where(
                ChannelMember.channel_id.in_(dm_ids)
            )
        ):
            dm_members[cid].append(uid)
        # Deactivated people stay visible in their DMs so the conversation still makes sense.
        for cid, uids in (await admin.deactivated_dm_members(db, workspace_id, dm_ids)).items():
            dm_members[cid].extend(uids)

    out = []
    for c in channels:
        item = ChannelOut.model_validate(c)
        item.is_member = c.id in member_of
        item.unread_count = unread.get(c.id, 0)
        item.member_ids = dm_members.get(c.id, [])
        item.my_role = my_roles.get(c.id)
        out.append(item)
    return out


@router.post(
    "/workspaces/{workspace_id}/channels",
    response_model=ChannelOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_channel(
    workspace_id: uuid.UUID, data: ChannelIn, db: DB, user: CurrentUser, membership: FullMembership
) -> ChannelOut:
    if data.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use the DM endpoint for direct messages")
    await admin.require_policy(
        db,
        membership,
        "create_private_channels" if data.kind == ChannelKind.private else "create_public_channels",
    )
    taken = await db.scalar(
        select(Channel.id).where(Channel.workspace_id == workspace_id, Channel.name == data.name)
    )
    if taken:
        raise HTTPException(status.HTTP_409_CONFLICT, "Channel name already exists")
    members = set(data.member_ids) | {user.id}
    await _assert_workspace_members(db, workspace_id, members)

    channel = Channel(
        workspace_id=workspace_id,
        created_by=user.id,
        **data.model_dump(exclude={"member_ids"}),
    )
    db.add(channel)
    try:
        await db.flush()
    except IntegrityError:  # lost a race with a concurrent create of the same name
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Channel name already exists") from None
    added = await add_members(db, channel.id, members)
    # The creator manages the channel (rename, archive, remove people, promote managers).
    await db.execute(
        update(ChannelMember)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id == user.id)
        .values(role=admin.MANAGER)
    )
    await db.commit()
    await notify_joined(channel.id, added)
    out = ChannelOut.model_validate(channel)
    out.my_role = admin.MANAGER
    await productivity.notify_channel_invite(db, channel, user.id, added)
    if channel.kind == ChannelKind.public:
        # Everyone else in the workspace can now browse/join it without reloading.
        listing = out.model_copy(update={"is_member": False, "my_role": None})
        await publish_to_workspace(
            workspace_id, {"type": "channel.created", "channel": listing.model_dump(mode="json")}
        )
    return out


async def _assert_guest_can_dm(db, user_id: uuid.UUID, workspace_id: uuid.UUID, others: set) -> None:
    """Guests may only DM people they already share a channel with."""
    shared = set(
        await db.scalars(
            select(ChannelMember.user_id)
            .join(Channel, Channel.id == ChannelMember.channel_id)
            .where(
                Channel.workspace_id == workspace_id,
                ChannelMember.channel_id.in_(
                    select(ChannelMember.channel_id).where(ChannelMember.user_id == user_id)
                ),
                ChannelMember.user_id.in_(others),
            )
        )
    )
    if shared != others:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Guests can only message people in their channels")


@router.post("/workspaces/{workspace_id}/dms", response_model=ChannelOut)
async def open_dm(
    workspace_id: uuid.UUID, data: DMIn, db: DB, user: CurrentUser, membership: WorkspaceMembership
) -> ChannelOut:
    """Find or create the DM between the current user and `user_ids` (1:1 or group)."""
    members = set(data.user_ids) | {user.id}
    await _assert_workspace_members(db, workspace_id, members)
    if is_guest(membership) and members != {user.id}:
        await _assert_guest_can_dm(db, user.id, workspace_id, members - {user.id})
    # Deterministic name => the same set of people always lands in the same DM. Regular channels
    # can't use the `dm-` prefix, and the lookup below also requires kind == dm.
    digest = hashlib.sha1(",".join(sorted(str(u) for u in members)).encode()).hexdigest()
    name = f"{DM_NAME_PREFIX}{digest[:24]}"

    # Insert-if-missing in one statement so two people opening the same DM at once both succeed.
    created_id = await db.scalar(
        pg_insert(Channel)
        .values(
            id=uuid.uuid4(),
            workspace_id=workspace_id,
            name=name,
            kind=ChannelKind.dm,
            created_by=user.id,
            is_archived=False,
        )
        .on_conflict_do_nothing(index_elements=["workspace_id", "name"])
        .returning(Channel.id)
    )
    added: set[uuid.UUID] = set()
    if created_id:
        added = await add_members(db, created_id, members)
    await db.commit()
    channel = await db.scalar(
        select(Channel).where(
            Channel.workspace_id == workspace_id, Channel.name == name, Channel.kind == ChannelKind.dm
        )
    )
    if not channel:
        # A legacy non-DM channel squats on this name; never hand it out as a DM.
        raise HTTPException(status.HTTP_409_CONFLICT, "Could not open this conversation")
    if added:
        await notify_joined(channel.id, added)

    item = ChannelOut.model_validate(channel)
    item.member_ids = await _member_ids(db, channel.id)
    return item


@router.get("/channels/{channel_id}", response_model=ChannelOut)
async def get_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> ChannelOut:
    item = ChannelOut.model_validate(channel)
    item.my_role = await db.scalar(
        select(ChannelMember.role).where(
            ChannelMember.channel_id == channel.id, ChannelMember.user_id == user.id
        )
    )
    item.is_member = item.my_role is not None
    if channel.kind == ChannelKind.dm:
        item.member_ids = await _member_ids(db, channel.id)
        ghosts = await admin.deactivated_dm_members(db, channel.workspace_id, [channel.id])
        item.member_ids += ghosts.get(channel.id, [])
    return item


@router.post("/channels/{channel_id}/join", response_model=ChannelOut)
async def join_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> Channel:
    # ChannelAccess already rejects private channels/DMs (and, for guests, any channel)
    # the user isn't in.
    ensure_not_archived(channel)
    added = await add_members(db, channel.id, {user.id})
    await db.commit()
    await notify_joined(channel.id, added)
    return channel


@router.get("/channels/{channel_id}/members", response_model=list[uuid.UUID])
async def list_channel_members(channel: ChannelAccess, db: DB) -> list[uuid.UUID]:
    return await _member_ids(db, channel.id)


@router.post("/channels/{channel_id}/members", status_code=status.HTTP_204_NO_CONTENT)
async def add_channel_member(
    data: ChannelMemberIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> None:
    if channel.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Start a new DM to add people")
    ensure_not_archived(channel)
    await _require_full_member_of(db, channel, user.id)
    if not await is_channel_member(db, channel.id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the channel first")
    await _assert_workspace_members(db, channel.workspace_id, {data.user_id})
    added = await add_members(db, channel.id, {data.user_id})
    await db.commit()
    await notify_joined(channel.id, added)
    await productivity.notify_channel_invite(db, channel, user.id, added)


@router.post("/channels/{channel_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(channel: ChannelAccess, db: DB, user: CurrentUser) -> None:
    await db.execute(
        update(ChannelMember)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id == user.id)
        .values(last_read_at=func.now())
    )
    await db.commit()
    # Read receipts: DMs / group DMs broadcast channel.read (no-op for other channels).
    await publish_read_state(db, channel, user.id)


def channel_updated_event(channel: Channel) -> dict:
    return {
        "type": "channel.updated",
        "channel_id": str(channel.id),
        "topic": channel.topic,
        "name": channel.name,
        "is_archived": channel.is_archived,
    }


async def _publish_channel_updated(channel: Channel) -> None:
    event = channel_updated_event(channel)
    await publish_to_channel(channel.id, event)
    if channel.kind == ChannelKind.public:
        # People browsing (not in) the channel see renames/archives in the directory too.
        await publish_to_workspace(channel.workspace_id, {**event, "workspace_id": str(channel.workspace_id)})


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(
    data: ChannelPatchIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> Channel:
    """Members set the topic; channel managers and workspace admins may also rename."""
    if channel.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "DMs have no topic")
    ensure_not_archived(channel)
    if not await is_channel_member(db, channel.id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the channel first")
    fields = data.model_fields_set or {"topic"}
    renamed_from = None
    if "name" in fields and data.name and data.name != channel.name:
        member = await get_workspace_membership(db, channel.workspace_id, user.id)
        if not await admin.can_manage_channel(db, channel, member):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only channel managers and admins can rename")
        if channel.name == "general" or data.name == "general":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "#general can't be renamed")
        taken = await db.scalar(
            select(Channel.id).where(
                Channel.workspace_id == channel.workspace_id, Channel.name == data.name
            )
        )
        if taken:
            raise HTTPException(status.HTTP_409_CONFLICT, "Channel name already exists")
        renamed_from, channel.name = channel.name, data.name
        admin.record_audit(
            db, channel.workspace_id, user.id, "channel.renamed", "channel", channel.id,
            {"from": renamed_from, "to": data.name},
        )
    if "topic" in fields:
        channel.topic = (data.topic or "").strip() or None
    try:
        await db.commit()
    except IntegrityError:  # lost a race with a concurrent rename/create
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Channel name already exists") from None
    await _publish_channel_updated(channel)
    return channel


@router.delete("/channels/{channel_id}/members/me", status_code=status.HTTP_204_NO_CONTENT)
async def leave_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> None:
    if channel.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't leave a DM")
    if channel.name == "general":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Everyone stays in #general")
    left = await db.scalar(
        delete(ChannelMember)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id == user.id)
        .returning(ChannelMember.id)
    )
    if left and channel.kind == ChannelKind.private and not await _member_ids(db, channel.id):
        # Nobody can ever get back into an empty private channel; retire it.
        channel.is_archived = True
    await db.commit()
    if not left:
        return
    # Drop the channel from this user's live sockets (otherwise they'd keep receiving its events).
    await notify_user(user.id, {"type": "channel.left", "channel_id": str(channel.id)})
    await publish_to_channel(
        channel.id,
        {"type": "channel.member_left", "channel_id": str(channel.id), "user_id": str(user.id)},
    )


@router.get("/channels/{channel_id}/files", response_model=list[ChannelFileOut])
async def list_channel_files(channel: ChannelAccess, db: DB) -> list[ChannelFileOut]:
    rows = list(
        await db.scalars(
            select(Attachment)
            .join(Message, Message.id == Attachment.message_id)
            .where(Message.channel_id == channel.id, Message.deleted_at.is_(None))
            .order_by(Attachment.created_at.desc())
            .limit(100)
        )
    )
    urls = await asyncio.gather(
        *(
            asyncio.to_thread(storage.presigned_get, a.storage_key, a.filename, a.content_type)
            for a in rows
        )
    )
    return [
        ChannelFileOut(
            id=a.id,
            filename=a.filename,
            content_type=a.content_type,
            size=a.size,
            url=url,
            kind=a.kind,
            duration_ms=a.duration_ms,
            waveform=a.waveform,
            message_id=a.message_id,
            uploader_id=a.uploader_id,
            created_at=a.created_at,
        )
        for a, url in zip(rows, urls, strict=True)
    ]


# --- Channel managers, removal, archive (Wave D1) ---------------------------------------------
# Declared after DELETE /channels/{id}/members/me so that route keeps matching "me".


async def _manager_context(db, channel: Channel, user_id: uuid.UUID) -> WorkspaceMember:
    """The caller's workspace membership, if they may manage this channel (else 403)."""
    if channel.kind == ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "DMs have no managers")
    member = await get_workspace_membership(db, channel.workspace_id, user_id)
    if not await admin.can_manage_channel(db, channel, member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only channel managers and admins can do that")
    return member


@router.get("/channels/{channel_id}/roles", response_model=ChannelRolesOut)
async def channel_roles(channel: ChannelAccess, db: DB, user: CurrentUser) -> ChannelRolesOut:
    member = await get_workspace_membership(db, channel.workspace_id, user.id)
    can_manage = await admin.can_manage_channel(db, channel, member)
    can_archive = (
        can_manage
        and channel.name != "general"
        and await admin.policy_allows(db, member, "archive_channels")
    )
    return ChannelRolesOut(
        manager_ids=[] if channel.kind == ChannelKind.dm else await admin.manager_ids(db, channel.id),
        can_manage=can_manage,
        can_archive=can_archive,
    )


@router.patch("/channels/{channel_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def set_channel_member_role(
    user_id: uuid.UUID,
    data: ChannelMemberRolePatch,
    channel: ChannelAccess,
    db: DB,
    user: CurrentUser,
) -> None:
    ensure_not_archived(channel)
    await _manager_context(db, channel, user.id)
    current = await db.scalar(
        select(ChannelMember)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id == user_id)
        .with_for_update()
    )
    if not current:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member of this channel")
    if data.role == admin.MANAGER:
        target = await get_workspace_membership(db, channel.workspace_id, user_id)
        person = await db.get(User, user_id)
        if not target or target.role == WorkspaceRole.guest or person.is_bot:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Guests and apps can't manage channels")
    if current.role == data.role:
        return
    previous, current.role = current.role, data.role
    admin.record_audit(
        db, channel.workspace_id, user.id, "channel.member_role_changed", "channel", channel.id,
        {"user_id": str(user_id), "from": previous, "to": data.role},
    )
    await db.commit()
    await publish_to_channel(
        channel.id,
        {
            "type": "channel.member_role_changed",
            "channel_id": str(channel.id),
            "user_id": str(user_id),
            "role": data.role,
        },
    )


@router.delete("/channels/{channel_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_channel_member(
    user_id: uuid.UUID, channel: ChannelAccess, db: DB, user: CurrentUser
) -> None:
    """Managers/admins remove someone (use DELETE .../members/me to leave yourself)."""
    if user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use leave to remove yourself")
    actor = await _manager_context(db, channel, user.id)
    if channel.name == "general":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Everyone stays in #general")
    target = await get_workspace_membership(db, channel.workspace_id, user_id)
    if target and admin.is_admin_role(target.role) and not admin.is_admin_role(actor.role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can remove workspace admins")
    removed = await db.scalar(
        delete(ChannelMember)
        .where(ChannelMember.channel_id == channel.id, ChannelMember.user_id == user_id)
        .returning(ChannelMember.id)
    )
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member of this channel")
    admin.record_audit(
        db, channel.workspace_id, user.id, "channel.member_removed", "channel", channel.id,
        {"user_id": str(user_id)},
    )
    await db.commit()
    await notify_user(user_id, {"type": "channel.left", "channel_id": str(channel.id)})
    await publish_to_channel(
        channel.id,
        {"type": "channel.member_left", "channel_id": str(channel.id), "user_id": str(user_id)},
    )


async def _set_archived(channel: Channel, db, user: CurrentUser, archived: bool) -> Channel:
    member = await _manager_context(db, channel, user.id)
    await admin.require_policy(db, member, "archive_channels")
    if channel.name == "general":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "#general can't be archived")
    if channel.is_archived == archived:
        return channel
    channel.is_archived = archived
    admin.record_audit(
        db, channel.workspace_id, user.id,
        "channel.archived" if archived else "channel.unarchived", "channel", channel.id,
        {"name": channel.name},
    )
    await db.commit()
    await _publish_channel_updated(channel)
    return channel


@router.post("/channels/{channel_id}/archive", response_model=ChannelOut)
async def archive_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> ChannelOut:
    """Archived channels are read-only; policy `archive_channels` + channel manager/admin."""
    await _set_archived(channel, db, user, True)
    return await get_channel(channel, db, user)


@router.post("/channels/{channel_id}/unarchive", response_model=ChannelOut)
async def unarchive_channel(channel: ChannelAccess, db: DB, user: CurrentUser) -> ChannelOut:
    await _set_archived(channel, db, user, False)
    return await get_channel(channel, db, user)
