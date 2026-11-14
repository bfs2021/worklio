"""Wave A2 messaging routes: pins, bookmarks, forwards, scheduled sends, polls, link previews,
edit history, DM read state and user groups."""

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from app import admin as admin_service
from app import messaging_extras as mx
from app.api.deps import (
    DB,
    ChannelAccess,
    CurrentUser,
    FullMembership,
    WorkspaceMembership,
    ensure_not_archived,
    get_workspace_membership,
    is_channel_member,
    require_channel_access,
)
from app.api.routes.messages import create_message
from app.models import (
    Attachment,
    Channel,
    ChannelBookmark,
    ChannelKind,
    ChannelMember,
    Message,
    MessageForward,
    MessagePin,
    MessageRevision,
    MessageUnfurl,
    Poll,
    PollOption,
    PollVote,
    ScheduledMessage,
    User,
    UserGroup,
    UserGroupMember,
    WorkspaceMember,
    WorkspaceRole,
)
from app.schemas import MessageIn, MessageOut, PollOut
from app.schemas_messaging import (
    BookmarkIn,
    BookmarkOut,
    BookmarkPatch,
    ForwardIn,
    MessageEditOut,
    PollIn,
    PollVoteIn,
    ReadStateOut,
    ScheduledIn,
    ScheduledOut,
    ScheduledPatch,
    UserGroupIn,
    UserGroupOut,
    UserGroupPatch,
)
from app.services import serialize_messages

router = APIRouter(tags=["messaging"])

MAX_PINS_PER_CHANNEL = 100
MAX_BOOKMARKS_PER_CHANNEL = 50
MAX_PENDING_SCHEDULED_PER_USER = 200
MAX_GROUPS_PER_WORKSPACE = 200
FORWARD_PREVIEW_CHARS = 500


async def _require_member(db, channel: Channel, user: User) -> None:
    if not await is_channel_member(db, channel.id, user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Join the channel first")


async def _serialize_one(db, msg: Message, viewer_id: uuid.UUID | None = None) -> MessageOut:
    return (await serialize_messages(db, [msg], viewer_id=viewer_id))[0]


async def _broadcast_updated(db, msg: Message) -> MessageOut:
    """Publish message.updated (viewer-neutral) and return that payload."""
    out = await _serialize_one(db, msg)
    await mx.publish_to_channel(msg.channel_id, mx.message_event("message.updated", out))
    return out


# --- Pins -------------------------------------------------------------------------------------


@router.post("/messages/{message_id}/pin", response_model=MessageOut)
async def pin_message(message_id: uuid.UUID, db: DB, user: CurrentUser) -> MessageOut:
    msg, channel = await mx.get_readable_message(db, user, message_id)
    ensure_not_archived(channel)
    await _require_member(db, channel, user)
    already = await db.get(MessagePin, msg.id)
    if already is None:
        count = await db.scalar(
            select(func.count()).select_from(MessagePin).where(MessagePin.channel_id == channel.id)
        )
        if count >= MAX_PINS_PER_CHANNEL:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"A channel can have at most {MAX_PINS_PER_CHANNEL} pinned messages",
            )
        await db.execute(
            pg_insert(MessagePin)
            .values(message_id=msg.id, channel_id=channel.id, pinned_by=user.id)
            .on_conflict_do_nothing(index_elements=["message_id"])
        )
        await db.commit()
        await _broadcast_updated(db, msg)
    return await _serialize_one(db, msg, user.id)


@router.delete("/messages/{message_id}/pin", response_model=MessageOut)
async def unpin_message(message_id: uuid.UUID, db: DB, user: CurrentUser) -> MessageOut:
    msg, channel = await mx.get_readable_message(db, user, message_id)
    ensure_not_archived(channel)
    await _require_member(db, channel, user)
    removed = await db.scalar(
        delete(MessagePin).where(MessagePin.message_id == msg.id).returning(MessagePin.message_id)
    )
    await db.commit()
    if removed:
        await _broadcast_updated(db, msg)
    return await _serialize_one(db, msg, user.id)


@router.get("/channels/{channel_id}/pins", response_model=list[MessageOut])
async def list_pins(channel: ChannelAccess, db: DB, user: CurrentUser) -> list[MessageOut]:
    """Pinned messages, most recently pinned first."""
    rows = list(
        await db.scalars(
            select(Message)
            .join(MessagePin, MessagePin.message_id == Message.id)
            .where(MessagePin.channel_id == channel.id, Message.deleted_at.is_(None))
            .order_by(MessagePin.pinned_at.desc())
            .limit(MAX_PINS_PER_CHANNEL)
        )
    )
    return await serialize_messages(db, rows, viewer_id=user.id)


# --- Bookmarks --------------------------------------------------------------------------------


async def _bookmarks(db, channel_id: uuid.UUID) -> list[BookmarkOut]:
    rows = await db.scalars(
        select(ChannelBookmark)
        .where(ChannelBookmark.channel_id == channel_id)
        .order_by(ChannelBookmark.position, ChannelBookmark.created_at)
    )
    return [BookmarkOut.model_validate(b) for b in rows]


async def _publish_bookmarks(db, channel_id: uuid.UUID) -> None:
    items = await _bookmarks(db, channel_id)
    await mx.publish_to_channel(
        channel_id,
        {
            "type": "bookmarks.updated",
            "channel_id": str(channel_id),
            "bookmarks": [b.model_dump(mode="json") for b in items],
        },
    )


async def _editable_bookmark(db, user: User, bookmark_id: uuid.UUID) -> ChannelBookmark:
    bookmark = await db.get(ChannelBookmark, bookmark_id)
    if bookmark is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bookmark not found")
    try:
        channel = await require_channel_access(bookmark.channel_id, db, user)
    except HTTPException:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bookmark not found") from None
    ensure_not_archived(channel)
    await _require_member(db, channel, user)
    return bookmark


@router.get("/channels/{channel_id}/bookmarks", response_model=list[BookmarkOut])
async def list_bookmarks(channel: ChannelAccess, db: DB) -> list[BookmarkOut]:
    return await _bookmarks(db, channel.id)


@router.post(
    "/channels/{channel_id}/bookmarks",
    response_model=BookmarkOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_bookmark(
    data: BookmarkIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> BookmarkOut:
    ensure_not_archived(channel)
    await _require_member(db, channel, user)
    count, last = (
        await db.execute(
            select(func.count(), func.max(ChannelBookmark.position)).where(
                ChannelBookmark.channel_id == channel.id
            )
        )
    ).one()
    if count >= MAX_BOOKMARKS_PER_CHANNEL:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"A channel can have at most {MAX_BOOKMARKS_PER_CHANNEL} bookmarks",
        )
    bookmark = ChannelBookmark(
        channel_id=channel.id,
        title=data.title,
        url=data.url,
        emoji=data.emoji,
        position=(last or 0) + 1,
        created_by=user.id,
    )
    db.add(bookmark)
    await db.commit()
    await _publish_bookmarks(db, channel.id)
    return BookmarkOut.model_validate(bookmark)


@router.patch("/bookmarks/{bookmark_id}", response_model=BookmarkOut)
async def update_bookmark(
    bookmark_id: uuid.UUID, data: BookmarkPatch, db: DB, user: CurrentUser
) -> BookmarkOut:
    bookmark = await _editable_bookmark(db, user, bookmark_id)
    changes = data.model_dump(exclude_unset=True)
    for key in ("title", "url", "position"):
        if changes.get(key) is not None:
            setattr(bookmark, key, changes[key])
    if "emoji" in changes:  # null clears it
        bookmark.emoji = changes["emoji"]
    await db.commit()
    await _publish_bookmarks(db, bookmark.channel_id)
    return BookmarkOut.model_validate(bookmark)


@router.delete("/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmark(bookmark_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    bookmark = await _editable_bookmark(db, user, bookmark_id)
    channel_id = bookmark.channel_id
    await db.delete(bookmark)
    await db.commit()
    await _publish_bookmarks(db, channel_id)


# --- Forward ----------------------------------------------------------------------------------


@router.post("/messages/{message_id}/forward", response_model=list[MessageOut])
async def forward_message(
    message_id: uuid.UUID, data: ForwardIn, db: DB, user: CurrentUser
) -> list[MessageOut]:
    source, _ = await mx.get_readable_message(db, user, message_id)
    if source.kind == "system":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "System messages can't be forwarded")
    # Forwarding a bare forward shares the original, not an empty shell.
    origin = await db.get(MessageForward, source.id)
    if origin is not None and not source.body.strip():
        snapshot = {
            "source_message_id": origin.source_message_id,
            "source_channel_id": origin.source_channel_id,
            "source_author_id": origin.source_author_id,
            "source_created_at": origin.source_created_at,
            "body_preview": origin.body_preview,
        }
    else:
        snapshot = {
            "source_message_id": source.id,
            "source_channel_id": source.channel_id,
            "source_author_id": source.author_id,
            "source_created_at": source.created_at,
            "body_preview": source.body[:FORWARD_PREVIEW_CHARS],
        }

    targets: list[Channel] = []
    for channel_id in data.channel_ids:  # validate every target before posting anywhere
        channel = await require_channel_access(channel_id, db, user)
        if channel.workspace_id != source.workspace_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Channel not found")
        ensure_not_archived(channel)
        targets.append(channel)

    out = []
    for channel in targets:
        body = MessageIn.model_construct(body=data.comment or "", parent_id=None, attachment_ids=[])

        async def attach_origin(msg: Message) -> None:
            db.add(MessageForward(message_id=msg.id, **snapshot))
            await db.flush()

        out.append(await create_message(db, channel, user, body, before_commit=attach_origin))
    return out


# --- Scheduled send ---------------------------------------------------------------------------


async def _own_scheduled(db, user: User, scheduled_id: uuid.UUID, *, lock: bool = False):
    q = select(ScheduledMessage).where(
        ScheduledMessage.id == scheduled_id, ScheduledMessage.author_id == user.id
    )
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    row = await db.scalar(q)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Scheduled message not found")
    return row


@router.post(
    "/channels/{channel_id}/scheduled",
    response_model=ScheduledOut,
    status_code=status.HTTP_201_CREATED,
)
async def schedule_message(
    data: ScheduledIn, channel: ChannelAccess, db: DB, user: CurrentUser
) -> ScheduledMessage:
    ensure_not_archived(channel)
    if data.parent_id:
        parent = await db.get(Message, data.parent_id)
        if (
            not parent
            or parent.channel_id != channel.id
            or parent.parent_id is not None
            or parent.deleted_at is not None
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid thread parent")
    pending = await db.scalar(
        select(func.count())
        .select_from(ScheduledMessage)
        .where(ScheduledMessage.author_id == user.id, ScheduledMessage.status == "pending")
    )
    if pending >= MAX_PENDING_SCHEDULED_PER_USER:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many scheduled messages")
    if data.attachment_ids:
        ok = await db.scalar(
            select(func.count())
            .select_from(Attachment)
            .where(
                Attachment.id.in_(data.attachment_ids),
                Attachment.uploader_id == user.id,
                Attachment.workspace_id == channel.workspace_id,
                Attachment.message_id.is_(None),
                Attachment.id.not_in(mx.reserved_attachment_ids()),
            )
        )
        if ok != len(data.attachment_ids):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid attachment")
    row = ScheduledMessage(
        workspace_id=channel.workspace_id,
        channel_id=channel.id,
        author_id=user.id,
        parent_id=data.parent_id,
        body=data.body,
        attachment_ids=data.attachment_ids,
        send_at=data.send_at,
        status="pending",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    await mx.notify_user(user.id, mx.scheduled_event("scheduled.updated", row))
    return row


@router.get("/workspaces/{workspace_id}/scheduled", response_model=list[ScheduledOut])
async def list_scheduled(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    _: WorkspaceMembership,
    status_: Literal["pending", "sent", "failed", "cancelled"] | None = Query(None, alias="status"),
) -> list[ScheduledMessage]:
    """My scheduled messages. Default: still to send (pending + failed), soonest first."""
    q = select(ScheduledMessage).where(
        ScheduledMessage.workspace_id == workspace_id, ScheduledMessage.author_id == user.id
    )
    if status_:
        q = q.where(ScheduledMessage.status == status_)
    else:
        q = q.where(ScheduledMessage.status.in_(("pending", "failed")))
    order = ScheduledMessage.send_at.desc() if status_ in ("sent", "cancelled") else ScheduledMessage.send_at
    return list(await db.scalars(q.order_by(order).limit(200)))


@router.patch("/scheduled/{scheduled_id}", response_model=ScheduledOut)
async def update_scheduled(
    scheduled_id: uuid.UUID, data: ScheduledPatch, db: DB, user: CurrentUser
) -> ScheduledMessage:
    row = await _own_scheduled(db, user, scheduled_id, lock=True)
    if row.status not in ("pending", "failed"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"This message is already {row.status}")
    if data.body is not None:
        body = data.body.strip()
        if not body and not row.attachment_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Message needs text or an attachment"
            )
        row.body = body
    if data.send_at is not None:
        row.send_at = data.send_at
    # Editing a failed message re-arms it.
    if row.status == "failed":
        if row.send_at <= datetime.now(UTC):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick a new time in the future"
            )
        row.status, row.error = "pending", None
    await db.commit()
    await db.refresh(row)
    await mx.notify_user(user.id, mx.scheduled_event("scheduled.updated", row))
    return row


@router.delete("/scheduled/{scheduled_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_scheduled(scheduled_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    row = await _own_scheduled(db, user, scheduled_id, lock=True)
    if row.status == "sent":
        raise HTTPException(status.HTTP_409_CONFLICT, "This message was already sent")
    if row.status == "cancelled":
        return
    row.status = "cancelled"
    await db.commit()
    await mx.notify_user(user.id, mx.scheduled_event("scheduled.updated", row))


@router.post("/scheduled/{scheduled_id}/send-now", response_model=MessageOut)
async def send_scheduled_now(scheduled_id: uuid.UUID, db: DB, user: CurrentUser) -> MessageOut:
    await _own_scheduled(db, user, scheduled_id)  # ownership (404 for anyone else)
    return await mx.send_scheduled_now(db, scheduled_id)


# --- Polls ------------------------------------------------------------------------------------


@router.post(
    "/channels/{channel_id}/polls", response_model=MessageOut, status_code=status.HTTP_201_CREATED
)
async def create_poll(data: PollIn, channel: ChannelAccess, db: DB, user: CurrentUser) -> MessageOut:
    body = MessageIn.model_construct(body=data.question, parent_id=data.parent_id, attachment_ids=[])

    async def add_poll(msg: Message) -> None:
        poll = Poll(
            message_id=msg.id,
            workspace_id=channel.workspace_id,
            channel_id=channel.id,
            created_by=user.id,
            question=data.question,
            multiple=data.multiple,
            anonymous=data.anonymous,
        )
        db.add(poll)
        await db.flush()
        db.add_all(PollOption(poll_id=poll.id, position=i, text=t) for i, t in enumerate(data.options))
        await db.flush()

    return await create_message(db, channel, user, body, before_commit=add_poll)


async def _poll_for(db, user: User, poll_id: uuid.UUID, *, lock: bool = False):
    q = select(Poll).where(Poll.id == poll_id)
    if lock:
        q = q.with_for_update().execution_options(populate_existing=True)
    poll = await db.scalar(q)
    if poll is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Poll not found")
    try:
        msg, channel = await mx.get_readable_message(db, user, poll.message_id)
    except HTTPException:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Poll not found") from None
    return poll, msg, channel


async def _poll_changed(db, poll: Poll, msg: Message, user: User) -> PollOut:
    await _broadcast_updated(db, msg)  # broadcast without my_votes
    return (await mx.load_polls(db, [poll], user.id))[poll.id]


@router.post("/polls/{poll_id}/vote", response_model=PollOut)
async def vote(poll_id: uuid.UUID, data: PollVoteIn, db: DB, user: CurrentUser) -> PollOut:
    """Replace my votes with `option_ids` (an empty list withdraws my vote)."""
    # The row lock serializes votes per poll, so single-choice can't end up with two votes.
    poll, msg, channel = await _poll_for(db, user, poll_id, lock=True)
    ensure_not_archived(channel)
    if poll.closed_at is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This poll is closed")
    chosen = list(dict.fromkeys(data.option_ids))
    if len(chosen) > 1 and not poll.multiple:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This poll allows one choice")
    valid = set(await db.scalars(select(PollOption.id).where(PollOption.poll_id == poll.id)))
    if not set(chosen) <= valid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown poll option")
    await db.execute(delete(PollVote).where(PollVote.poll_id == poll.id, PollVote.user_id == user.id))
    db.add_all(PollVote(poll_id=poll.id, option_id=o, user_id=user.id) for o in chosen)
    await db.commit()
    return await _poll_changed(db, poll, msg, user)


@router.post("/polls/{poll_id}/close", response_model=PollOut)
async def close_poll(poll_id: uuid.UUID, db: DB, user: CurrentUser) -> PollOut:
    poll, msg, channel = await _poll_for(db, user, poll_id, lock=True)
    if poll.created_by != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the poll's author can close it")
    ensure_not_archived(channel)
    if poll.closed_at is None:
        poll.closed_at = datetime.now(UTC)
        await db.commit()
        return await _poll_changed(db, poll, msg, user)
    await db.commit()
    return (await mx.load_polls(db, [poll], user.id))[poll.id]


# --- Link previews ----------------------------------------------------------------------------


@router.delete("/messages/{message_id}/unfurls/{index}", status_code=status.HTTP_204_NO_CONTENT)
async def hide_unfurl(message_id: uuid.UUID, index: int, db: DB, user: CurrentUser) -> None:
    """Author hides one preview (by its position in `unfurls`); it stays hidden after edits."""
    msg, channel = await mx.get_readable_message(db, user, message_id)
    if msg.author_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only modify your own messages")
    ensure_not_archived(channel)
    row = await db.scalar(
        select(MessageUnfurl).where(MessageUnfurl.message_id == msg.id).with_for_update()
    )
    items = list(row.items or []) if row else []
    if not 0 <= index < len(items):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Preview not found")
    url = items.pop(index)["url"]
    row.items = items
    row.hidden_urls = [*(row.hidden_urls or []), url]
    await db.commit()
    await _broadcast_updated(db, msg)


# --- Edit history / read state ----------------------------------------------------------------


@router.get("/messages/{message_id}/edits", response_model=list[MessageEditOut])
async def list_edits(message_id: uuid.UUID, db: DB, user: CurrentUser) -> list[MessageEditOut]:
    """Earlier versions, oldest first. `edited_at` is when that version was replaced."""
    msg, _ = await mx.get_readable_message(db, user, message_id)
    rows = await db.scalars(
        select(MessageRevision)
        .where(MessageRevision.message_id == msg.id)
        .order_by(MessageRevision.edited_at, MessageRevision.id)
    )
    return [MessageEditOut(body=r.body, edited_at=r.edited_at) for r in rows]


@router.get("/channels/{channel_id}/read-state", response_model=list[ReadStateOut])
async def read_state(channel: ChannelAccess, db: DB) -> list[ReadStateOut]:
    """When each member last read this DM (for "Seen" receipts). DMs and group DMs only."""
    if channel.kind != ChannelKind.dm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Read receipts are only kept for DMs")
    rows = await db.execute(
        select(ChannelMember.user_id, ChannelMember.last_read_at).where(
            ChannelMember.channel_id == channel.id
        )
    )
    return [ReadStateOut(user_id=u, last_read_at=t) for u, t in rows]


# --- User groups ------------------------------------------------------------------------------


async def _group_out(db, groups: list[UserGroup]) -> list[UserGroupOut]:
    members: dict[uuid.UUID, list[uuid.UUID]] = {g.id: [] for g in groups}
    if groups:
        for gid, uid in await db.execute(
            select(UserGroupMember.group_id, UserGroupMember.user_id).where(
                UserGroupMember.group_id.in_(list(members))
            )
        ):
            members[gid].append(uid)
    return [
        UserGroupOut(
            id=g.id,
            workspace_id=g.workspace_id,
            handle=g.handle,
            name=g.name,
            member_ids=sorted(members[g.id], key=str),
            created_by=g.created_by,
            created_at=g.created_at,
        )
        for g in groups
    ]


async def _check_members(db, workspace_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    wanted = set(ids)
    if not wanted:
        return wanted
    found = set(
        await db.scalars(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id.in_(wanted)
            )
        )
    )
    if found != wanted:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "All users must be workspace members")
    return wanted


async def _publish_groups(workspace_id: uuid.UUID) -> None:
    await mx.publish_to_workspace(
        workspace_id, {"type": "groups.updated", "workspace_id": str(workspace_id)}
    )


async def _editable_group(db, user: User, group_id: uuid.UUID) -> UserGroup:
    group = await db.get(UserGroup, group_id)
    member = await get_workspace_membership(db, group.workspace_id, user.id) if group else None
    if not group or not member:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Group not found")
    is_admin = member.role in (WorkspaceRole.owner, WorkspaceRole.admin)
    if not is_admin and (member.role == WorkspaceRole.guest or group.created_by != user.id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins or the group's creator can do that")
    return group


@router.get("/workspaces/{workspace_id}/groups", response_model=list[UserGroupOut])
async def list_groups(workspace_id: uuid.UUID, db: DB, _: WorkspaceMembership) -> list[UserGroupOut]:
    groups = list(
        await db.scalars(
            select(UserGroup).where(UserGroup.workspace_id == workspace_id).order_by(UserGroup.handle)
        )
    )
    return await _group_out(db, groups)


@router.post(
    "/workspaces/{workspace_id}/groups",
    response_model=UserGroupOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_group(
    workspace_id: uuid.UUID, data: UserGroupIn, db: DB, user: CurrentUser, membership: FullMembership
) -> UserGroupOut:
    await admin_service.require_policy(db, membership, "create_user_groups")
    count = await db.scalar(
        select(func.count()).select_from(UserGroup).where(UserGroup.workspace_id == workspace_id)
    )
    if count >= MAX_GROUPS_PER_WORKSPACE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Too many groups in this workspace")
    members = await _check_members(db, workspace_id, data.member_ids)
    group = UserGroup(workspace_id=workspace_id, handle=data.handle, name=data.name, created_by=user.id)
    db.add(group)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"@{data.handle} is already taken") from None
    db.add_all(UserGroupMember(group_id=group.id, user_id=u) for u in members)
    await db.commit()
    await db.refresh(group)
    await _publish_groups(workspace_id)
    return (await _group_out(db, [group]))[0]


@router.patch("/groups/{group_id}", response_model=UserGroupOut)
async def update_group(
    group_id: uuid.UUID, data: UserGroupPatch, db: DB, user: CurrentUser
) -> UserGroupOut:
    group = await _editable_group(db, user, group_id)
    if data.handle is not None:
        group.handle = data.handle
    if data.name is not None:
        group.name = data.name
    if data.member_ids is not None:
        members = await _check_members(db, group.workspace_id, data.member_ids)
        await db.execute(delete(UserGroupMember).where(UserGroupMember.group_id == group.id))
        db.add_all(UserGroupMember(group_id=group.id, user_id=u) for u in members)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"@{data.handle} is already taken") from None
    await db.refresh(group)
    await _publish_groups(group.workspace_id)
    return (await _group_out(db, [group]))[0]


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(group_id: uuid.UUID, db: DB, user: CurrentUser) -> None:
    group = await _editable_group(db, user, group_id)
    workspace_id = group.workspace_id
    await db.delete(group)
    await db.commit()
    await _publish_groups(workspace_id)
