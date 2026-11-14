"""Browse views: sent messages, huddle/call history, workspace files and unreads."""

import asyncio
import uuid
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Query, status
from sqlalchemy import and_, func, not_, or_, select

from app import calls as call_service
from app import productivity as svc
from app.api.deps import DB, CurrentUser, WorkspaceMembership, is_guest, readable_channel_ids
from app.core import storage
from app.models import (
    Attachment,
    Call,
    Channel,
    ChannelKind,
    ChannelMember,
    ChannelPref,
    Message,
    MessageMention,
    User,
)
from app.models.call import LIVE_CALL_STATUSES
from app.realtime.hub import notify_user, publish_to_channel
from app.schemas import MessageOut
from app.schemas_productivity import (
    CallHistoryOut,
    Page,
    UnreadChannelOut,
    WorkspaceFileOut,
)
from app.services import serialize_messages

router = APIRouter(tags=["productivity"])

UNREAD_MESSAGES_PER_CHANNEL = 20
NOTES_PREVIEW_CHARS = 200


def _readable(workspace_id: uuid.UUID, user, membership):
    return readable_channel_ids(workspace_id, user.id, is_guest(membership))


# --- Sent ---------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/sent", response_model=Page[MessageOut])
async def list_sent(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(30, ge=1, le=100),
) -> dict:
    """My recent messages (top-level and thread replies), newest first."""
    q = select(Message).where(
        Message.workspace_id == workspace_id,
        Message.author_id == user.id,
        Message.kind == "user",
        Message.channel_id.in_(_readable(workspace_id, user, membership)),
        *svc.visible_message(Message),
    )
    q = svc.keyset_before(q, Message.created_at, Message.id, cursor)
    rows = list(
        await db.scalars(q.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit + 1))
    )
    rows, next_cursor = svc.page_of(rows, limit, lambda m: (m.created_at, m.id))
    return {
        "items": await serialize_messages(db, rows, viewer_id=user.id),
        "next_cursor": next_cursor,
    }


# --- Huddles / calls history --------------------------------------------------------------


async def _channel_labels(db, channels: list[Channel], viewer_id: uuid.UUID) -> dict:
    labels = {c.id: f"#{c.name}" for c in channels if c.kind != ChannelKind.dm}
    dm_ids = [c.id for c in channels if c.kind == ChannelKind.dm]
    if dm_ids:
        names: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = defaultdict(list)
        for cid, uid, name in await db.execute(
            select(ChannelMember.channel_id, User.id, User.full_name)
            .join(User, User.id == ChannelMember.user_id)
            .where(ChannelMember.channel_id.in_(dm_ids))
            .order_by(User.full_name)
        ):
            names[cid].append((uid, name))
        for cid in dm_ids:
            others = [n for uid, n in names[cid] if uid != viewer_id]
            mine = [n for uid, n in names[cid] if uid == viewer_id]
            labels[cid] = ", ".join(others) if others else f"{mine[0] if mine else 'You'} (you)"
    return labels


@router.get("/workspaces/{workspace_id}/calls", response_model=Page[CallHistoryOut])
async def list_calls(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    status_: Literal["active", "ended"] | None = Query(None, alias="status"),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(20, ge=1, le=50),
) -> dict:
    """Calls and huddles in channels I can read, newest first. `active` = ringing or live."""
    live = [s.value for s in LIVE_CALL_STATUSES]
    q = select(Call).where(
        Call.workspace_id == workspace_id,
        Call.channel_id.in_(_readable(workspace_id, user, membership)),
    )
    if status_ == "active":
        q = q.where(Call.status.in_(live))
    elif status_ == "ended":
        q = q.where(Call.status.not_in(live))
    q = svc.keyset_before(q, Call.started_at, Call.id, cursor)
    rows = list(
        await db.scalars(q.order_by(Call.started_at.desc(), Call.id.desc()).limit(limit + 1))
    )
    rows, next_cursor = svc.page_of(rows, limit, lambda c: (c.started_at, c.id))
    channels = (
        list(await db.scalars(select(Channel).where(Channel.id.in_({c.channel_id for c in rows}))))
        if rows
        else []
    )
    labels = await _channel_labels(db, channels, user.id)
    items = []
    for call in rows:
        base = await call_service.serialize_call(db, call)
        notes = call_service.notes_to_text(call.notes or {}).strip()
        items.append(
            CallHistoryOut(
                **base.model_dump(),
                channel_label_hint=labels.get(call.channel_id, "Conversation"),
                notes_preview=notes[:NOTES_PREVIEW_CHARS] or None,
                duration_s=call_service.duration_s(call),
            )
        )
    return {"items": items, "next_cursor": next_cursor}


# --- Files --------------------------------------------------------------------------------

FileType = Literal["all", "images", "videos", "audio", "documents", "recordings"]
RECORDING_KINDS = ("voice", "video_clip", "screen_recording")


def _type_filter(kind: FileType):
    ct = Attachment.content_type
    media = or_(ct.like("image/%"), ct.like("video/%"), ct.like("audio/%"))
    return {
        "all": None,
        "images": ct.like("image/%"),
        "videos": ct.like("video/%"),
        "audio": ct.like("audio/%"),
        "documents": and_(not_(media), Attachment.kind.is_(None)),
        "recordings": Attachment.kind.in_(RECORDING_KINDS),
    }[kind]


def _like_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/workspaces/{workspace_id}/files", response_model=Page[WorkspaceFileOut])
async def list_files(
    workspace_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    membership: WorkspaceMembership,
    type: FileType = "all",
    user_id: uuid.UUID | None = None,
    channel_id: uuid.UUID | None = None,
    q: str | None = Query(None, max_length=200),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(30, ge=1, le=100),
) -> dict:
    """Files shared in channels I can read, newest first."""
    query = (
        select(Attachment, Message.channel_id)
        .join(Message, Message.id == Attachment.message_id)
        .where(
            Attachment.workspace_id == workspace_id,
            Message.workspace_id == workspace_id,
            Message.channel_id.in_(_readable(workspace_id, user, membership)),
            *svc.visible_message(Message),
        )
    )
    cond = _type_filter(type)
    if cond is not None:
        query = query.where(cond)
    if user_id:
        query = query.where(Attachment.uploader_id == user_id)
    if channel_id:
        query = query.where(Message.channel_id == channel_id)
    if q and q.strip():
        query = query.where(Attachment.filename.ilike(f"%{_like_escape(q.strip())}%", escape="\\"))
    query = svc.keyset_before(query, Attachment.created_at, Attachment.id, cursor)
    rows = list(
        (
            await db.execute(
                query.order_by(Attachment.created_at.desc(), Attachment.id.desc()).limit(limit + 1)
            )
        ).all()
    )
    rows, next_cursor = svc.page_of(rows, limit, lambda r: (r[0].created_at, r[0].id))
    urls = await asyncio.gather(
        *(
            asyncio.to_thread(storage.presigned_get, a.storage_key, a.filename, a.content_type)
            for a, _ in rows
        )
    )
    items = [
        WorkspaceFileOut(
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
            channel_id=cid,
        )
        for (a, cid), url in zip(rows, urls, strict=True)
    ]
    return {"items": items, "next_cursor": next_cursor}


# --- Unreads ------------------------------------------------------------------------------


@router.get("/workspaces/{workspace_id}/unreads", response_model=list[UnreadChannelOut])
async def list_unreads(
    workspace_id: uuid.UUID, db: DB, user: CurrentUser, _: WorkspaceMembership
) -> list[UnreadChannelOut]:
    """Channels I'm in with unread messages (archived ones skipped), muted ones last.

    Each carries up to 20 of its newest unread messages, oldest first.
    """
    unread_join = (
        select(Message)
        .join(
            ChannelMember,
            and_(ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user.id),
        )
        .join(Channel, Channel.id == Message.channel_id)
        .where(
            Message.workspace_id == workspace_id,
            Channel.is_archived.is_(False),
            *svc.unread_message_filter(user.id),
        )
    )
    unread_ids = unread_join.with_only_columns(Message.id).subquery()
    stats = list(
        (
            await db.execute(
                unread_join.with_only_columns(
                    Message.channel_id,
                    func.count(),
                    func.min(Message.created_at),
                    func.max(Message.created_at),
                ).group_by(Message.channel_id)
            )
        ).all()
    )
    if not stats:
        return []
    mentions = dict(
        (
            await db.execute(
                select(Message.channel_id, func.count())
                .join(MessageMention, MessageMention.message_id == Message.id)
                .where(
                    MessageMention.user_id == user.id,
                    Message.id.in_(select(unread_ids.c.id)),
                )
                .group_by(Message.channel_id)
            )
        ).all()
    )
    muted = set(
        await db.scalars(
            select(ChannelPref.channel_id).where(
                ChannelPref.user_id == user.id,
                ChannelPref.workspace_id == workspace_id,
                ChannelPref.muted.is_(True),
            )
        )
    )
    rn = (
        func.row_number()
        .over(
            partition_by=Message.channel_id,
            order_by=(Message.created_at.desc(), Message.id.desc()),
        )
        .label("rn")
    )
    ranked = (
        select(Message.id, rn).where(Message.id.in_(select(unread_ids.c.id))).subquery()
    )
    messages = list(
        await db.scalars(
            select(Message)
            .join(ranked, ranked.c.id == Message.id)
            .where(ranked.c.rn <= UNREAD_MESSAGES_PER_CHANNEL)
            .order_by(Message.created_at, Message.id)
        )
    )
    serialized = await serialize_messages(db, messages, viewer_id=user.id)
    by_channel: dict[uuid.UUID, list] = defaultdict(list)
    for m in serialized:
        by_channel[m.channel_id].append(m)

    stats.sort(key=lambda s: (s[0] in muted, -s[3].timestamp()))
    return [
        UnreadChannelOut(
            channel_id=cid,
            unread_count=count,
            mention_count=mentions.get(cid, 0),
            first_unread_at=first,
            muted=cid in muted,
            messages=by_channel[cid],
        )
        for cid, count, first, _last in stats
    ]


@router.post("/workspaces/{workspace_id}/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def read_all(workspace_id: uuid.UUID, db: DB, user: CurrentUser, _: WorkspaceMembership) -> None:
    marked = await svc.mark_all_read(db, workspace_id, user.id)
    await db.commit()
    await notify_user(
        user.id, {"type": "channels.read_all", "workspace_id": str(workspace_id)}
    )
    for channel_id, kind, at in marked:
        if kind == ChannelKind.dm:  # read receipts are shown in DMs only
            await publish_to_channel(
                channel_id,
                {
                    "type": "channel.read",
                    "channel_id": str(channel_id),
                    "user_id": str(user.id),
                    "last_read_at": at.isoformat(),
                },
            )
